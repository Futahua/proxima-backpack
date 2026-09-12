/**
 * The Projects Hub's lifecycle actions: the shell's half of `project.create`, `archive`, `restore`
 * and `delete`.
 *
 * Same shape as every other write sequence in this tree, and for the same reason: the sequence lives
 * in the app layer where a test can execute it against a real store, the shell supplies only its own
 * state and sinks, and every accepted write is followed by a re-read rather than a redraw from a
 * guess.
 *
 * One thing is different here, and it is the interesting one. **Delete carries its own confirmation
 * into the operation.** The creator answered the open question (D60): deleting a project deletes the
 * members the caller confirmed, so this layer's delete takes the task and event ids the surface
 * captured and passes them through unchanged, and the operation verifies them against the store
 * before it removes anything. A list that no longer matches is refused as `membership-mismatch`
 * rather than acted on, which is the same answer the UI and an agent get for all five verbs — the
 * property the stage's parity box asks for — and the reason the verb can no longer be called without
 * saying what it means.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { IdGenerator } from '../domain/clock.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import type { ProximaState } from '../domain/types.js';
import type { CreateProjectRequest, ProjectFieldMutation, ProjectMutationFailureReason, ProjectMutationResult } from './projectMutations.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { convergeAfterWrite } from './writeConvergence.js';

export const PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION = 1 as const;

export type ProjectLifecycleVerb = 'create' | 'update' | 'archive' | 'restore' | 'delete';

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface ProjectLifecycleOperations {
  createProject(request: CreateProjectRequest): Promise<ProjectMutationResult>;
  updateProject(input: {
    projectId: OpaqueRecordId;
    expectedRevision: string;
    mutations: readonly ProjectFieldMutation[];
  }): Promise<ProjectMutationResult>;
  archiveProject(input: { projectId: OpaqueRecordId; expectedRevision: string }): Promise<ProjectMutationResult>;
  restoreProject(input: { projectId: OpaqueRecordId; expectedRevision: string }): Promise<ProjectMutationResult>;
  deleteProject(input: {
    projectId: OpaqueRecordId;
    expectedRevision: string;
    members: {
      tasks: readonly OpaqueRecordId[];
      events: readonly OpaqueRecordId[];
    };
  }): Promise<ProjectMutationResult>;
}

export interface ProjectLifecycleDependencies extends ProjectLifecycleOperationDependencies {
  readonly state: ProximaState | null;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
}

/**
 * What the operation needs, and nothing a cockpit owns.
 *
 * The one fact a lifecycle run ever took from a projection was a project's revision, and a caller that read
 * the record has that - so it arrives through `resolveRevision` and the family is reachable from an entry with
 * no hub to consult. `settle` is where a surface draws the answer, and it is absent on a caller that has none.
 */
export interface ProjectLifecycleOperationDependencies {
  readonly writes: () => Promise<ProjectLifecycleOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  readonly ids: IdGenerator;
  readonly audit: SemanticAuditSink;
  readonly settle?: (outcome: ProjectLifecycleOutcome) => void;
}

/** Where the revision a lifecycle write carries comes from: the caller that read the record. */
export type ProjectRevisionResolver = () => string | null;

export type ProjectLifecycleFailureReason =
  | 'unknown-project'
  | 'writes-unavailable'
  | ProjectMutationFailureReason;

export type ProjectLifecycleOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly verb: ProjectLifecycleVerb;
      readonly outcome: 'created' | 'updated' | 'archived' | 'restored' | 'deleted';
  /** Every entity the run affected, so a cascade reports its members as well as the project. */
  readonly affectedEntityIds: readonly OpaqueRecordId[];
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly recordId: OpaqueRecordId;
      readonly revision: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly verb: ProjectLifecycleVerb;
      readonly reason: ProjectLifecycleFailureReason;
      readonly detail: string;
      /** Present on a refusal too - including the delete policy refusal, which is a real answer. */
      readonly requestId: string;
      readonly refreshed: boolean;
    };

function refused(
  verb: ProjectLifecycleVerb,
  reason: ProjectLifecycleFailureReason,
  detail: string,
  requestId: string,
  refreshed = false,
): ProjectLifecycleOutcome {
  return { ok: false, schemaVersion: PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION, verb, reason, detail, requestId, refreshed };
}

/**
 * Run one lifecycle write and converge the surfaces, under the semantic envelope.
 *
 * One sequence for all five verbs - create, update, archive, restore and the confirmed delete - so the id is
 * minted here rather than five times, one terminal event follows after convergence, and the journal names the
 * verb as `project.<verb>`, which is the name each row of Stage 17's matrix already uses. A create has no id
 * yet, so its refusals name no target rather than guessing one.
 *
 * @param deps - the shell's pieces.
 * @param verb - which lifecycle operation this is, so the result says what was attempted.
 * @param projectId - the project, or null for a create (which has no id yet).
 * @param write - the operation to call once a path has resolved.
 * @returns the outcome, with the store's revision when it was accepted.
 */
export async function runLifecycle(
  deps: ProjectLifecycleOperationDependencies,
  verb: ProjectLifecycleVerb,
  projectId: string | null,
  resolveRevision: ProjectRevisionResolver | null,
  write: (operations: ProjectLifecycleOperations, revision: string) => Promise<ProjectMutationResult>,
): Promise<ProjectLifecycleOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: `project.${verb}`,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };
  const target = projectId === null ? [] : [projectId];

  let revision = '';
  if (projectId !== null) {
    const resolved = resolveRevision?.() ?? null;
    if (resolved === null) {
      // A verb that names a project must say which revision it read. The hub answers that by finding the
      // project it was showing; a caller that read the record supplies the revision, so it has no such answer
      // and this branch is the hub's. Every verb in this family carries a project except a create, which is
      // why there is no `unsupported-verb` arm here - the whole family is reachable without a hub.
      audit('rejected', target, 'unknown-project');
      return refused(verb, 'unknown-project', 'the hub has no project with that id', requestId);
    }
    revision = resolved;
  }

  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    const refusal = refused(verb, 'writes-unavailable', reason, requestId);
    deps.settle?.(refusal);
    audit('rejected', target, 'writes-unavailable');
    return refusal;
  }

  const written = await write(operations, revision);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) {
    const refusal = refused(verb, written.reason, written.detail, requestId, convergence.refreshed);
    deps.settle?.(refusal);
    audit(semanticOutcomeOf({ wrote: 0, refused: true }), target, written.reason);
    return refusal;
  }

  const accepted: ProjectLifecycleOutcome = {
    ok: true,
    schemaVersion: PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION,
    verb,
    outcome: written.outcome,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    refreshed: convergence.refreshed,
    affectedEntityIds: written.affectedEntityIds,
  };
  deps.settle?.(accepted);
  audit(semanticOutcomeOf({ wrote: 1, refused: false }), written.affectedEntityIds);
  return accepted;
}

/**
 * The hub's entry over the operation: answer with the revision it is showing, and draw the answer.
 *
 * Everything the cockpit owns is here - the projection the revision comes from, the refusal sink and the
 * redraw - and the operation above knows none of it.
 */
async function runLifecycleFromHub(
  deps: ProjectLifecycleDependencies,
  verb: ProjectLifecycleVerb,
  projectId: string | null,
  write: (operations: ProjectLifecycleOperations, revision: string) => Promise<ProjectMutationResult>,
): Promise<ProjectLifecycleOutcome> {
  // The lookup happens once, here, and it decides two things: the revision the write carries, and whether the
  // hub clears the refusal it is showing. A project the hub cannot show clears nothing - the hub has no answer
  // to give, so the refusal already on screen is still the true one, and the sequence refuses with its own.
  const revision = projectId === null
    ? null
    : deps.state?.projects.find((candidate) => candidate.id === projectId)?.source.revision ?? null;
  if (projectId === null || revision !== null) deps.setRefusal(null);

  return await runLifecycle(
    {
      ...deps,
      settle: (outcome) => {
        if (!outcome.ok) deps.setRefusal(outcome.reason);
        deps.render();
      },
    },
    verb,
    projectId,
    () => revision,
    write,
  );
}

export async function createProjectAction(
  deps: ProjectLifecycleDependencies,
  input: CreateProjectRequest,
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycleFromHub(deps, 'create', null, async (operations) => await operations.createProject(input));
}

/**
 * Update a project's own fields — the edit form's Save.
 *
 * An empty mutation list is passed through rather than short-circuited here: the operation's own
 * answer for it (`validation-refused`, "an update with no field to change is not an update") is the
 * one a caller should hear, and it is reached without reading or writing the store.
 */
export async function updateProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string; readonly mutations: readonly ProjectFieldMutation[] },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycleFromHub(deps, 'update', input.projectId, async (operations, revision) => await operations.updateProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
    mutations: input.mutations,
  }));
}

export async function archiveProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycleFromHub(deps, 'archive', input.projectId, async (operations, revision) => await operations.archiveProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}

export async function restoreProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycleFromHub(deps, 'restore', input.projectId, async (operations, revision) => await operations.restoreProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}

/**
 * Delete a project, with the members the caller confirmed — and pass the answer through.
 *
 * The request carries the membership because the operation verifies it: a delete that named only a
 * project id would be asking to remove records it never listed. A refusal here is the operation's own
 * reason — `membership-mismatch` when the confirmed list is no longer the current one, or the store's
 * own typed failure — rather than a wrapper, so a caller that wants to say *why* nothing happened has
 * the sentence the operation wrote.
 */
export async function deleteProjectAction(
  deps: ProjectLifecycleDependencies,
  input: {
    readonly projectId: string;
    readonly members: {
      readonly tasks: readonly string[];
      readonly events: readonly string[];
    };
  },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycleFromHub(deps, 'delete', input.projectId, async (operations, revision) => await operations.deleteProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
    members: {
      tasks: input.members.tasks as readonly OpaqueRecordId[],
      events: input.members.events as readonly OpaqueRecordId[],
    },
  }));
}
