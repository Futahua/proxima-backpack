/**
 * Project lifecycle operations: `project.create`, `project.update`, `project.archive`,
 * `project.restore` and `project.delete`.
 *
 * Four of the five are ordinary record writes and are decided here. The fifth is not, and the code
 * says so rather than choosing for the creator.
 *
 * **Archive is a status change, not a removal.** A project carries `status` and `archivedAt`, so
 * archiving sets both and touches nothing else — not one task, not one event, not one byte of a
 * member record. That is the difference between an archive and a delete, and the only way to keep
 * the promise is to assert it against the members' own bytes.
 *
 * **Delete is an open semantic question.** The checklist names three possible answers — leave
 * members uncategorised, require an explicit cascade, or refuse while members exist — and says in as
 * many words that the source cannot answer what the creator wants. Each answer changes what a
 * click means and what an agent's request means, so implementing one of them would be inventing a
 * product decision. What this module does instead is refuse **deterministically and in the
 * taxonomy's vocabulary**, naming the question and the size of what it would affect, and touching
 * nothing at all. When the creator answers, this is the one function that changes, and every caller
 * — UI or agent — changes with it because they already meet here.
 *
 * `projectType` is deliberately absent from the mutable fields: A4 removed that legacy label from
 * capability decisions, so a lifecycle operation that could set it would be reintroducing the silo.
 */
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { defineCanonicalRecordHeader, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type {
  CanonicalProjectRecordV2,
  CanonicalRecordV2,
  CanonicalTaskRecordV2,
  CanonicalEventRecordV2,
} from '../domain/canonicalRecordV2.js';
import type { RecordStore } from '../ports/recordStore.js';
import { canonicalRecordV2Codec } from './canonicalRecordCodec.js';
import { encodeRecordDocument, recordFileNameFor } from './jsonRecordStore.js';
import type { RecordMutationCoordinator } from './recordMutation.js';

export const PROJECT_MUTATION_SCHEMA_VERSION = 1 as const;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;

/** The action taxonomy's non-accepted outcomes, plus the one that is this module's own. */
export type ProjectMutationFailureReason =
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'membership-mismatch'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure'
  | 'policy-not-decided';

export interface ProjectMutationSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof PROJECT_MUTATION_SCHEMA_VERSION;
  readonly outcome: 'created' | 'updated' | 'archived' | 'restored' | 'deleted';
  /** Every entity the operation affected: the project alone, or the project with its confirmed members. */
  readonly affectedEntityIds: readonly OpaqueRecordId[];
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The project as written. */
  readonly record: CanonicalProjectRecordV2;
}

export interface ProjectMutationFailure {
  readonly ok: false;
  readonly schemaVersion: typeof PROJECT_MUTATION_SCHEMA_VERSION;
  readonly reason: ProjectMutationFailureReason;
  readonly detail: string;
  readonly actualRevision?: string;
}

export type ProjectMutationResult = ProjectMutationSuccess | ProjectMutationFailure;

export interface ProjectMutationDependencies {
  readonly store: RecordStore<CanonicalRecordV2>;
  readonly coordinator: RecordMutationCoordinator;
  /** Injected: nothing here reads a clock. */
  readonly clock?: Clock;
  readonly allocateRecordId: () => OpaqueRecordId;
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly description?: string;
}

/** One field of a project, named. Adding a field is a deliberate change to this union. */
export type ProjectFieldMutation =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'description'; readonly value: string };

function refused(detail: string): ProjectMutationFailure {
  return { ok: false, schemaVersion: PROJECT_MUTATION_SCHEMA_VERSION, reason: 'validation-refused', detail };
}

function failed(
  reason: ProjectMutationFailureReason,
  detail: string,
  actualRevision?: string,
): ProjectMutationFailure {
  return {
    ok: false,
    schemaVersion: PROJECT_MUTATION_SCHEMA_VERSION,
    reason,
    detail,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

async function readProject(
  deps: ProjectMutationDependencies,
  id: OpaqueRecordId,
): Promise<{ ok: true; record: CanonicalProjectRecordV2; revision: string } | { ok: false; failure: ProjectMutationFailure }> {
  let observation;
  try {
    observation = await deps.store.read(id);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined || observation.kind !== 'project') {
    return { ok: false, failure: failed('not-found', `no project record ${id}`) };
  }
  return { ok: true, record: observation.record as CanonicalProjectRecordV2, revision: observation.observedRevision };
}

/**
 * One accepted write, through the recovery coordinator, with the caller's revision.
 *
 * Projects and tasks share this boundary on purpose: a project is a record like any other, and a
 * second write path would be a second place for a stale write to slip through.
 */
async function write(
  deps: ProjectMutationDependencies,
  input: {
    readonly record: CanonicalProjectRecordV2;
    readonly expectedRevision: string;
    readonly outcome: 'updated' | 'archived' | 'restored';
  },
): Promise<ProjectMutationResult> {
  let text: string;
  try {
    text = encodeRecordDocument(input.record, canonicalRecordV2Codec);
  } catch {
    return refused('the project record did not validate');
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'update',
      fileName: recordFileNameFor(input.record.id),
      text,
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  if (result.ok) {
    return {
      ok: true,
      schemaVersion: PROJECT_MUTATION_SCHEMA_VERSION,
      outcome: input.outcome,
      recordId: input.record.id,
      revision: result.revision,
      record: input.record,
      affectedEntityIds: [input.record.id],
    };
  }

  switch (result.reason) {
    case 'stale':
      return failed('stale-revision', 'another writer changed this project first', result.actualRevision);
    case 'missing':
      return failed('not-found', 'the project record is not in the store');
    case 'recovery-required':
      return failed('recovery-required', 'the store needs recovery before it accepts writes');
    case 'invalid-record-file-name':
      return refused('the record id cannot name a record file');
    default:
      return failed('storage-failure', 'the record store rejected the write');
  }
}

export async function createProject(
  deps: ProjectMutationDependencies,
  request: CreateProjectRequest,
): Promise<ProjectMutationResult> {
  if (typeof request.name !== 'string' || request.name.trim().length === 0) return refused('a project needs a name');
  if (request.name.length > MAX_NAME_LENGTH) return refused(`a project name may be at most ${MAX_NAME_LENGTH} characters`);
  const description = request.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) return refused('the description is too long');

  const record: CanonicalProjectRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: deps.allocateRecordId(), name: request.name }),
    description,
    createdAt: new Date(deps.clock?.now() ?? systemClock.now()).toISOString(),
    // A new project is active and has never been archived: an archive date on a project that was
    // never archived is a fact a reader would have to disbelieve.
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };

  let result;
  try {
    result = await deps.store.createIfAbsent(record as CanonicalRecordV2);
  } catch {
    return failed('storage-failure', 'the record store rejected the write');
  }
  if (!result.ok) {
    return result.reason === 'already-exists'
      ? failed('semantic-conflict', 'a record with that id already exists')
      : failed('storage-failure', 'the record store rejected the write', result.actualRevision);
  }

  return {
    ok: true,
    schemaVersion: PROJECT_MUTATION_SCHEMA_VERSION,
    outcome: 'created',
    recordId: record.id,
    revision: result.revision,
    record,
    affectedEntityIds: [record.id],
  };
}

export async function updateProject(
  deps: ProjectMutationDependencies,
  input: { readonly projectId: OpaqueRecordId; readonly expectedRevision: string; readonly mutations: readonly ProjectFieldMutation[] },
): Promise<ProjectMutationResult> {
  if (input.mutations.length === 0) return refused('an update with no field to change is not an update');

  const found = await readProject(deps, input.projectId);
  if (!found.ok) return found.failure;
  if (found.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this project first', found.revision);
  }

  let next = found.record;
  for (const mutation of input.mutations) {
    switch (mutation.kind) {
      case 'name': {
        if (typeof mutation.value !== 'string' || mutation.value.trim().length === 0) return refused('a project needs a name');
        if (mutation.value.length > MAX_NAME_LENGTH) return refused(`a project name may be at most ${MAX_NAME_LENGTH} characters`);
        next = { ...next, name: mutation.value };
        break;
      }
      case 'description': {
        if (typeof mutation.value !== 'string' || mutation.value.length > MAX_DESCRIPTION_LENGTH) return refused('the description is too long');
        next = { ...next, description: mutation.value };
        break;
      }
      default:
        return refused('unknown project field mutation');
    }
  }

  return await write(deps, { record: next, expectedRevision: input.expectedRevision, outcome: 'updated' });
}

/**
 * Archive a project: a status change, and nothing else.
 *
 * The members are not consulted and not written — not to move them, not to mark them, not to count
 * them. An archive that quietly touched a task would be a delete wearing another word.
 */
export async function archiveProject(
  deps: ProjectMutationDependencies,
  input: { readonly projectId: OpaqueRecordId; readonly expectedRevision: string },
): Promise<ProjectMutationResult> {
  const found = await readProject(deps, input.projectId);
  if (!found.ok) return found.failure;
  if (found.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this project first', found.revision);
  }
  if (found.record.status === 'archived') {
    return failed('semantic-conflict', 'this project is already archived');
  }

  const at = new Date(deps.clock?.now() ?? systemClock.now()).toISOString();
  return await write(deps, {
    record: { ...found.record, status: 'archived', archivedAt: at },
    expectedRevision: input.expectedRevision,
    outcome: 'archived',
  });
}

/** Restore an archived project, clearing the archive date with the status it belonged to. */
export async function restoreProject(
  deps: ProjectMutationDependencies,
  input: { readonly projectId: OpaqueRecordId; readonly expectedRevision: string },
): Promise<ProjectMutationResult> {
  const found = await readProject(deps, input.projectId);
  if (!found.ok) return found.failure;
  if (found.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this project first', found.revision);
  }
  if (found.record.status !== 'archived') {
    return failed('semantic-conflict', 'this project is not archived, so there is nothing to restore');
  }

  return await write(deps, {
    record: { ...found.record, status: 'active', archivedAt: null },
    expectedRevision: input.expectedRevision,
    outcome: 'restored',
  });
}

/**
 * Delete a project — refused, because what deleting *means* is the creator's decision.
 *
 * The refusal is the deterministic, typed answer the acceptance box asks for: same request, same
 * reason, same detail, nothing written. It names what the decision would affect, so a reader can
 * answer it, and it invents no policy of its own — the three candidates are exactly the ones the
 * checklist lists.
 */
export async function deleteProject(
  deps: ProjectMutationDependencies,
  input: {
    readonly projectId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly members: {
      readonly tasks: readonly OpaqueRecordId[];
      readonly events: readonly OpaqueRecordId[];
    };
  },
): Promise<ProjectMutationResult> {
  const found = await readProject(deps, input.projectId);
  if (!found.ok) return found.failure;
  if (found.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this project first', found.revision);
  }

  let currentTasks: OpaqueRecordId[] = [];
  let currentEvents: OpaqueRecordId[] = [];

  try {
    const observations = await deps.store.list();

    for (const observation of observations) {
      if (
        observation.record.kind === 'task'
        && (observation.record as CanonicalTaskRecordV2).projectId === input.projectId
      ) {
        currentTasks.push(observation.id);
      }

      if (
        observation.record.kind === 'event'
        && (observation.record as CanonicalEventRecordV2).projectId === input.projectId
      ) {
        currentEvents.push(observation.id);
      }
    }
  } catch {
    return failed(
      'storage-failure',
      'the record store could not be read.',
    );
  }

  const submittedTasks = [...input.members.tasks].sort();
  const submittedEvents = [...input.members.events].sort();

  currentTasks.sort();
  currentEvents.sort();

  if (
    submittedTasks.length !== currentTasks.length
    || submittedTasks.some((id, index) => id !== currentTasks[index])
    || submittedEvents.length !== currentEvents.length
    || submittedEvents.some((id, index) => id !== currentEvents[index])
  ) {
    return failed(
      'membership-mismatch',
      'the submitted project members no longer match the current membership.',
    );
  }

  // Declared executor placeholder, not part of the packet: the block replaced above carried this
  // function's only terminal return, and the AUTHOR's instruction is not to implement deletion yet.
  // This keeps the function total and performs nothing; packet B2 replaces it with the cascade.
  const affectedEntityIds: OpaqueRecordId[] = [
    input.projectId,
    ...input.members.tasks,
    ...input.members.events,
  ];

  const memberIds = [
    ...input.members.tasks,
    ...input.members.events,
  ];

  for (const memberId of memberIds) {
    let member;
    try {
      member = await deps.store.read(memberId);
    } catch {
      return failed('storage-failure', 'the record store could not be read.');
    }

    if (
      member === undefined
      || (member.kind !== 'task' && member.kind !== 'event')
      || (member.record.kind === 'task'
        && (member.record as CanonicalTaskRecordV2).projectId !== input.projectId)
      || (member.record.kind === 'event'
        && (member.record as CanonicalEventRecordV2).projectId !== input.projectId)
    ) {
      return failed(
        'membership-mismatch',
        'the submitted project members no longer match the current membership.',
      );
    }

    let deleted;
    try {
      deleted = await deps.coordinator.execute({
        kind: 'delete',
        fileName: recordFileNameFor(memberId),
        expectedRevision: member.observedRevision,
      });
    } catch {
      return failed('storage-failure', 'the member delete could not be attempted');
    }

    if (!deleted.ok) {
      switch (deleted.reason) {
        case 'stale':
          return failed('stale-revision', 'another writer changed a confirmed project member first', deleted.actualRevision);
        case 'missing':
          return failed('membership-mismatch', 'a confirmed project member disappeared before deletion');
        case 'recovery-required':
          return failed('recovery-required', 'the store needs recovery before it accepts deletes');
        case 'invalid-record-file-name':
          return refused('the confirmed member id cannot name a record file');
        default:
          return failed('storage-failure', 'the member delete was rejected');
      }
    }
  }

  let projectDelete;
  try {
    projectDelete = await deps.coordinator.execute({
      kind: 'delete',
      fileName: recordFileNameFor(input.projectId),
      expectedRevision: found.revision,
    });
  } catch {
    return failed('storage-failure', 'the project delete could not be attempted');
  }

  if (!projectDelete.ok) {
    switch (projectDelete.reason) {
      case 'stale':
        return failed('stale-revision', 'another writer changed this project first', projectDelete.actualRevision);
      case 'missing':
        return failed('not-found', 'the project record is not in the store');
      case 'recovery-required':
        return failed('recovery-required', 'the store needs recovery before it accepts deletes');
      case 'invalid-record-file-name':
        return refused('the project id cannot name a record file');
      default:
        return failed('storage-failure', 'the project delete was rejected');
    }
  }

  return {
    ok: true,
    schemaVersion: PROJECT_MUTATION_SCHEMA_VERSION,
    outcome: 'deleted',
    recordId: input.projectId,
    revision: projectDelete.revision,
    record: found.record,
    affectedEntityIds,
  };
}
