/**
 * The browser's sanctioned task-write path, resolved behind one seam.
 *
 * Stage 9 needs a gesture to cause a durable write, and `recordMutationContainment` needs the
 * browser shell to hold no RecordStore authority. Both hold here because the shell receives
 * *operations*, not storage: this module composes the record backend, the recovery journal, the
 * startup recovery gate and the mutation coordinator, and hands back four callables.
 *
 * Nothing is exposed until three things are true, and each gets its own refusal because they
 * mean different things to whoever is looking:
 *
 * 1. **An activation marker exists.** Writing records nothing will read is worse than refusing:
 *    startup only chooses the store for an activated store, so an unactivated write would be
 *    invisible in the product.
 * 2. **The recovery journal loads and reconciles.** `startRecordMutationAuthority` is Stage 7's
 *    gate — a prepared-but-unresolved effect blocks authority rather than writing over it, and
 *    its own docblock says no semantic action was wired to it yet. This is that wiring.
 * 3. **The record files can be listed.** A store that cannot be enumerated cannot be written to
 *    safely, because the write path resolves the record it is about to change.
 *
 * Every failure is returned rather than thrown: a caller that cannot write should still render.
 */
import { createCanonicalJsonRecordStore } from '../app/canonicalRecordCodec.js';
import { createDurableRecoveryStore } from '../app/vaultRecovery.js';
import { startRecordMutationAuthority } from '../app/recordRecoveryStartup.js';
import type { StartupRecoveryCandidate } from '../app/startupSession.js';
import { readRecordStoreActivation } from '../app/recordStoreActivation.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  restoreProject,
  updateProject as updateProjectRecord,
  type CreateProjectRequest,
  type ProjectFieldMutation,
  type ProjectMutationResult,
} from '../app/projectMutations.js';
import {
  createTask,
  deleteTask,
  updateTask,
  type CreateTaskRequest,
  type TaskFieldMutation,
  type TaskMutationDependencies,
  type TaskMutationResult,
} from '../app/taskMutations.js';
import {
  createEvent,
  deleteEvent,
  rescheduleEvent,
  resizeEvent,
  updateEvent,
  type CreateEventRequest,
  type EventFieldMutation,
  type EventMutationResult,
  type EventResizeTarget,
} from '../app/eventMutations.js';
import {
  createWorkflowStage,
  deleteWorkflowStage,
  renameWorkflowStage,
  type CreateWorkflowStageRequest,
  type WorkflowStageMutationResult,
  type WorkflowStageMutationDependencies,
  type WorkflowStageRemapTarget,
} from '../app/workflowStageMutations.js';
import {
  createPropertySchema,
  deletePropertySchema,
  updatePropertySchema,
  updateSchemaField,
  updateSchemaOption,
  type CreatePropertySchemaRequest,
  type PropertySchemaMutationDependencies,
  type PropertySchemaMutationResult,
  type SchemaOptionMutation,
} from '../app/propertySchemaMutations.js';
import type { CanonicalPropertyDefinition, CanonicalPropertySchemaRecord } from '../domain/canonicalSchema.js';
import { opaqueSchemaOptionIdFromRandomBytes, type OpaqueSchemaOptionId } from '../domain/canonicalSchema.js';
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  createBrowserOpfsRecordRecoveryJournalBackend,
  createBrowserOpfsRecordStoreActivationStorage,
  createBrowserOpfsRecordStoreFileBackend,
} from './opfsRecordStoreFileBackend.js';

/** The task verbs. */
export interface BrowserTaskMutations {
  createTask(request: CreateTaskRequest): Promise<TaskMutationResult>;
  updateTask(input: { taskId: OpaqueRecordId; expectedRevision: string; mutations: readonly TaskFieldMutation[] }): Promise<TaskMutationResult>;
  deleteTask(input: { taskId: OpaqueRecordId; expectedRevision: string }): Promise<TaskMutationResult>;
}

/** The project lifecycle verbs. `delete` answers with the policy refusal while that is undecided. */
export interface BrowserProjectMutations {
  createProject(request: CreateProjectRequest): Promise<ProjectMutationResult>;
  updateProject(input: { projectId: OpaqueRecordId; expectedRevision: string; mutations: readonly ProjectFieldMutation[] }): Promise<ProjectMutationResult>;
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

/** The event verbs. A reschedule and a resize are their own operations, not field updates. */
export interface BrowserEventMutations {
  createEvent(request: CreateEventRequest): Promise<EventMutationResult>;
  updateEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; mutations: readonly EventFieldMutation[] }): Promise<EventMutationResult>;
  deleteEvent(input: { eventId: OpaqueRecordId; expectedRevision: string }): Promise<EventMutationResult>;
  rescheduleEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; startDate: string }): Promise<EventMutationResult>;
  resizeEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; target: EventResizeTarget }): Promise<EventMutationResult>;
}

/** Everything one activated store hands a surface, resolved once. */
/** The workflow-stage verbs: the project workflow's own records, not its tasks. */
export interface BrowserWorkflowStageMutations {
  createWorkflowStage(request: CreateWorkflowStageRequest): Promise<WorkflowStageMutationResult>;
  renameWorkflowStage(input: { stageId: OpaqueRecordId; expectedRevision: string; name: string }): Promise<WorkflowStageMutationResult>;
  /** A delete that does not say where the cards go is refused while the stage still holds any. */
  deleteWorkflowStage(input: { stageId: OpaqueRecordId; expectedRevision: string; remapTo?: WorkflowStageRemapTarget }): Promise<WorkflowStageMutationResult>;
}

/**
 * The property-schema verbs, structurally.
 *
 * A schema is a record of its own kind with its own operations, so it is its own port rather than a member of
 * the task one - and it is the port that gives the schema editor its UI caller, which the parity agenda's three
 * schema rows have been waiting for.
 */
export interface BrowserPropertySchemaMutations {
  createPropertySchema(request: CreatePropertySchemaRequest): Promise<PropertySchemaMutationResult>;
  updatePropertySchema(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly name?: string;
    readonly definition?: CanonicalPropertyDefinition;
  }): Promise<PropertySchemaMutationResult>;
  updateSchemaField(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly definition: CanonicalPropertyDefinition;
  }): Promise<PropertySchemaMutationResult>;
  updateSchemaOption(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly option: SchemaOptionMutation;
  }): Promise<PropertySchemaMutationResult>;
  deletePropertySchema(input: { schemaId: OpaqueRecordId; expectedRevision: string }): Promise<PropertySchemaMutationResult>;
  /**
   * Every canonical schema record, each with the revision the store observed.
   *
   * A read beside the writes, and it is here rather than in the surface for the reason this boundary exists: a
   * record store is this layer's business. The schema editor needs the revision and the canonical definition,
   * and `ProximaState.taskSchema` carries neither - it is the legacy shape, whose options have a `name` and a
   * `color` and whose records have no observed revision. A surface that read the store itself would be reaching
   * past the composition this file exists to be.
   */
  readPropertySchemaRecords(): Promise<readonly { readonly record: CanonicalPropertySchemaRecord; readonly revision: string }[]>;
}

/** Everything one activated store hands a surface, resolved once. */
export type BrowserRecordMutations = BrowserTaskMutations & BrowserProjectMutations & BrowserEventMutations & BrowserWorkflowStageMutations & BrowserPropertySchemaMutations;

export type BrowserTaskMutationResolution =
  | { readonly ok: true; readonly mutations: BrowserRecordMutations }
  | {
      readonly ok: false;
      readonly reason: 'not-activated' | 'recovery-blocked' | 'store-unreadable';
      readonly detail: string;
    };

/** The other identity this adapter mints: a select option's, which the schema verbs allocate one at a time. */
function freshSchemaOptionId(): OpaqueSchemaOptionId {
  const bytes = new Uint8Array(16);
  return opaqueSchemaOptionIdFromRandomBytes(bytes);
}

/**
 * The startup half of the same gate: reconcile the durable journal on the boot itself.
 *
 * `resolveBrowserTaskMutations` already runs the gate, but it runs it when a write is first
 * attempted, and a store that is never written to is a store whose journal is never read -
 * including the boot after a crash, which is the one boot that needs it. This composes the
 * same backend, journal and gate and returns the answer; it grants nothing, creates no
 * coordinator and holds no storage the caller can reach.
 */
export async function resolveBrowserRecoveryStartup(
  options: { readonly clock?: Clock } = {},
): Promise<StartupRecoveryCandidate & { readonly detail: string }> {
  let backend;
  let journal;
  let activation;
  try {
    backend = await createBrowserOpfsRecordStoreFileBackend();
    journal = await createBrowserOpfsRecordRecoveryJournalBackend();
    activation = await createBrowserOpfsRecordStoreActivationStorage();
  } catch {
    return { mutationAuthority: 'blocked', outcomes: 0, unresolved: 0, reason: 'store-unreadable', detail: 'record store unavailable' };
  }

  let marker;
  try {
    marker = await readRecordStoreActivation(activation);
  } catch {
    marker = { status: 'invalid' as const, marker: null, detail: 'activation storage could not be read' };
  }
  if (marker.status !== 'present' || marker.marker === null) {
    // No activation means no canonical records and no journal to reconcile: reported as the
    // reason rather than as a clean reconciliation, because "nothing was pending" and "nothing
    // was examined" are different answers.
    return {
      mutationAuthority: 'blocked',
      outcomes: 0,
      unresolved: 0,
      reason: 'not-activated',
      detail: marker.status === 'absent' ? 'the record store has never been activated' : marker.detail,
    };
  }

  const recovery = createDurableRecoveryStore(journal);
  const authority = await startRecordMutationAuthority({ backend, recovery, clock: options.clock ?? systemClock });
  return {
    mutationAuthority: authority.mutationAuthority,
    outcomes: authority.outcomes.length,
    unresolved: authority.unresolved,
    reason: authority.mutationAuthority === 'available' ? null : authority.reason.slice(0, 200),
    detail: `reconciled ${authority.outcomes.length} record(s), ${authority.unresolved} unresolved`,
  };
}

function freshRecordId(): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  // crypto.getRandomValues is the only source here, and it is a browser one: a record id that
  // could repeat would collide two records at one address.
  crypto.getRandomValues(bytes);
  return opaqueRecordIdFromRandomBytes(bytes);
}

export async function resolveBrowserTaskMutations(
  options: { readonly clock?: Clock } = {},
): Promise<BrowserTaskMutationResolution> {  let backend;
  let journal;
  let activation;
  try {
    backend = await createBrowserOpfsRecordStoreFileBackend();
    journal = await createBrowserOpfsRecordRecoveryJournalBackend();
    activation = await createBrowserOpfsRecordStoreActivationStorage();
  } catch (error) {
    return {
      ok: false,
      reason: 'store-unreadable',
      detail: `record store unavailable: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
    };
  }

  let marker;
  try {
    marker = await readRecordStoreActivation(activation);
  } catch {
    marker = { status: 'invalid' as const, marker: null, detail: 'activation storage could not be read' };
  }
  if (marker.status !== 'present' || marker.marker === null) {
    return {
      ok: false,
      reason: 'not-activated',
      detail: marker.status === 'absent'
        ? 'the record store has never been activated'
        : marker.detail,
    };
  }

  const recovery = createDurableRecoveryStore(journal);
  const authority = await startRecordMutationAuthority({ backend, recovery, clock: options.clock ?? systemClock });
  if (authority.mutationAuthority !== 'available') {
    return {
      ok: false,
      reason: 'recovery-blocked',
      detail: authority.reason.slice(0, 200),
    };
  }

  const store = createCanonicalJsonRecordStore(backend);
  try {
    await store.list();
  } catch (error) {
    return {
      ok: false,
      reason: 'store-unreadable',
      detail: `record store could not be listed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
    };
  }

  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    allocateRecordId: freshRecordId,
  };

  const projectDeps = deps;
  // The stage operations compose the task operations, because emptying a stage moves cards by the
  // rule that owns the stage-and-position pair rather than by a second implementation of it.
  const stageDeps: WorkflowStageMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    allocateRecordId: freshRecordId,
    taskDependencies: deps,
  };
  // A schema needs a second allocator besides its records: a select option carries its own opaque id, and the
  // record layer is the one that mints it - so this is the only other place in the tree that allocates identity,
  // and it allocates the kind the schema verbs expect.
  const schemaDeps: PropertySchemaMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    allocateRecordId: freshRecordId,
    allocateOptionId: freshSchemaOptionId,
  };

  return {
    ok: true,
    mutations: {
      createTask: (request) => createTask(deps, request),
      updateTask: (input) => updateTask(deps, input),
      deleteTask: (input) => deleteTask(deps, input),
      createProject: (request) => createProject(projectDeps, request),
      updateProject: (input) => updateProjectRecord(projectDeps, input),
      archiveProject: (input) => archiveProject(projectDeps, input),
      restoreProject: (input) => restoreProject(projectDeps, input),
      deleteProject: (input) => deleteProject(projectDeps, input),
      createEvent: (request) => createEvent(projectDeps, request),
      updateEvent: (input) => updateEvent(projectDeps, input),
      deleteEvent: (input) => deleteEvent(projectDeps, input),
      rescheduleEvent: (input) => rescheduleEvent(projectDeps, input),
      resizeEvent: (input) => resizeEvent(projectDeps, input),
      createWorkflowStage: (request) => createWorkflowStage(stageDeps, request),
      renameWorkflowStage: (input) => renameWorkflowStage(stageDeps, input),
      deleteWorkflowStage: (input) => deleteWorkflowStage(stageDeps, input),
      createPropertySchema: (request) => createPropertySchema(schemaDeps, request),
      updatePropertySchema: (input) => updatePropertySchema(schemaDeps, input),
      updateSchemaField: (input) => updateSchemaField(schemaDeps, input),
      updateSchemaOption: (input) => updateSchemaOption(schemaDeps, input),
      deletePropertySchema: (input) => deletePropertySchema(schemaDeps, input),
      readPropertySchemaRecords: async () => {
        // The same list the store would give, filtered to the schema kind and paired with each record's
        // observed revision - because a revision the reader did not observe is one a write must not name.
        const listed = await store.list();
        const records: { record: CanonicalPropertySchemaRecord; revision: string }[] = [];
        for (const entry of listed) {
          const observation = await store.read(entry.id);
          if (observation === null || observation === undefined || observation.record.kind !== 'schema') continue;
          records.push({ record: observation.record as CanonicalPropertySchemaRecord, revision: observation.observedRevision });
        }
        return records;
      },
    },
  };
}
