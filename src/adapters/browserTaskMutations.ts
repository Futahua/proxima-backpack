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
  updateEvent,
  type CreateEventRequest,
  type EventFieldMutation,
  type EventMutationResult,
} from '../app/eventMutations.js';
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
  deleteProject(input: { projectId: OpaqueRecordId; expectedRevision: string }): Promise<ProjectMutationResult>;
}

/** The event verbs. A reschedule and a resize are their own operations, not field updates. */
export interface BrowserEventMutations {
  createEvent(request: CreateEventRequest): Promise<EventMutationResult>;
  updateEvent(input: { eventId: OpaqueRecordId; expectedRevision: string; mutations: readonly EventFieldMutation[] }): Promise<EventMutationResult>;
  deleteEvent(input: { eventId: OpaqueRecordId; expectedRevision: string }): Promise<EventMutationResult>;
}

/** Everything one activated store hands a surface, resolved once. */
export type BrowserRecordMutations = BrowserTaskMutations & BrowserProjectMutations & BrowserEventMutations;

export type BrowserTaskMutationResolution =
  | { readonly ok: true; readonly mutations: BrowserRecordMutations }
  | {
      readonly ok: false;
      readonly reason: 'not-activated' | 'recovery-blocked' | 'store-unreadable';
      readonly detail: string;
    };

function freshRecordId(): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  // crypto.getRandomValues is the only source here, and it is a browser one: a record id that
  // could repeat would collide two records at one address.
  crypto.getRandomValues(bytes);
  return opaqueRecordIdFromRandomBytes(bytes);
}

export async function resolveBrowserTaskMutations(
  options: { readonly clock?: Clock } = {},
): Promise<BrowserTaskMutationResolution> {
  let backend;
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
    },
  };
}
