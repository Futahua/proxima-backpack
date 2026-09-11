/**
 * The Projects Hub's lifecycle actions: the shell's half of `project.create`, `archive`, `restore`
 * and `delete`.
 *
 * Same shape as every other write sequence in this tree, and for the same reason: the sequence lives
 * in the app layer where a test can execute it against a real store, the shell supplies only its own
 * state and sinks, and every accepted write is followed by a re-read rather than a redraw from a
 * guess.
 *
 * One thing is different here, and it is the interesting one. **Delete's refusal is an answer, not a
 * failure to wire.** `deleteProject` refuses `policy-not-decided` because what deleting does with a
 * project's members is the creator's decision (D56), and this layer passes that reason through
 * unchanged rather than flattening it into "unavailable": a reader who clicks Delete is told the
 * question and the counts it would affect. That also means the UI and an agent get the same answer
 * for all five verbs, which is the property the stage's parity box asks for.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
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
  deleteProject(input: { projectId: OpaqueRecordId; expectedRevision: string }): Promise<ProjectMutationResult>;
}

export interface ProjectLifecycleDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<ProjectLifecycleOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
}

export type ProjectLifecycleFailureReason =
  | 'unknown-project'
  | 'writes-unavailable'
  | ProjectMutationFailureReason;

export type ProjectLifecycleOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly verb: ProjectLifecycleVerb;
      readonly outcome: 'created' | 'updated' | 'archived' | 'restored';
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
      readonly refreshed: boolean;
    };

function refused(
  verb: ProjectLifecycleVerb,
  reason: ProjectLifecycleFailureReason,
  detail: string,
  refreshed = false,
): ProjectLifecycleOutcome {
  return { ok: false, schemaVersion: PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION, verb, reason, detail, refreshed };
}

/**
 * Run one lifecycle write and converge the surfaces.
 *
 * @param deps - the shell's pieces.
 * @param verb - which lifecycle operation this is, so the result says what was attempted.
 * @param projectId - the project, or null for a create (which has no id yet).
 * @param write - the operation to call once a path has resolved.
 * @returns the outcome, with the store's revision when it was accepted.
 */
async function runLifecycle(
  deps: ProjectLifecycleDependencies,
  verb: ProjectLifecycleVerb,
  projectId: string | null,
  write: (operations: ProjectLifecycleOperations, revision: string) => Promise<ProjectMutationResult>,
): Promise<ProjectLifecycleOutcome> {
  let revision = '';
  if (projectId !== null) {
    const project = deps.state?.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return refused(verb, 'unknown-project', 'the hub has no project with that id');
    revision = project.source.revision;
  }

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    return refused(verb, 'writes-unavailable', reason);
  }

  const written = await write(operations, revision);
  const convergence = await convergeAfterWrite(deps, {
    accepted: written.ok,
    lostRace: !written.ok && written.reason === 'stale-revision',
  });

  if (!written.ok) deps.setRefusal(written.reason);
  deps.render();

  return written.ok
    ? {
        ok: true,
        schemaVersion: PROJECT_LIFECYCLE_ACTION_SCHEMA_VERSION,
        verb,
        outcome: written.outcome,
        recordId: written.recordId,
        revision: written.revision,
        refreshed: convergence.refreshed,
      }
    : refused(verb, written.reason, written.detail, convergence.refreshed);
}

export async function createProjectAction(
  deps: ProjectLifecycleDependencies,
  input: CreateProjectRequest,
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycle(deps, 'create', null, async (operations) => await operations.createProject(input));
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
  return await runLifecycle(deps, 'update', input.projectId, async (operations, revision) => await operations.updateProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
    mutations: input.mutations,
  }));
}

export async function archiveProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycle(deps, 'archive', input.projectId, async (operations, revision) => await operations.archiveProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}

export async function restoreProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycle(deps, 'restore', input.projectId, async (operations, revision) => await operations.restoreProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}

/**
 * Delete a project — and pass the answer through.
 *
 * The refusal this returns is the operation's own reason (`policy-not-decided` while the creator has
 * not answered), not a wrapper: a caller that wants to say *why* nothing happened has the sentence
 * the operation wrote.
 */
export async function deleteProjectAction(
  deps: ProjectLifecycleDependencies,
  input: { readonly projectId: string },
): Promise<ProjectLifecycleOutcome> {
  return await runLifecycle(deps, 'delete', input.projectId, async (operations, revision) => await operations.deleteProject({
    projectId: input.projectId as OpaqueRecordId,
    expectedRevision: revision,
  }));
}
