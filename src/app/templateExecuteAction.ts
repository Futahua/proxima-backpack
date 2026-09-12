/**
 * The canonical `template.execute` submission, in the shape the other write actions use.
 *
 * This is the path the AUTHOR scoped on 2026-09-12, after ruling that the composer panel must not be the
 * next authority-bearing slice: one submission path, backed by `executeTemplatePlan`, which an agent and a
 * panel Confirm both call rather than each growing its own execution. It follows the house pattern that
 * `eventWriteActions.ts` sets - operations resolved structurally by the shell (no store, no coordinator, no
 * paths reachable from here), a refusal the surface can draw, convergence after the write, and a typed
 * outcome.
 *
 * What a caller needs to know about the result: `complete` means every draft became a record and `created`
 * names them; a refusal **after** a creation is `ok: false` with a non-empty `created`, so a surface can keep
 * its composer open and show what did land rather than closing as though the run had finished. The reason it
 * carries is the port's own cause rather than one word for every creation failure - `semantic-conflict` for a
 * lost race or a contradiction, `storage-failure` for a write that could not happen, `creation-refused` for a
 * request the port declined - which is what lets a surface say which of the three it is. Nothing here retries
 * or rolls back: the ids are returned so the caller can offer correction, which is the rule the AUTHOR gave
 * for the panel.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { IdGenerator } from '../domain/clock.js';
import type { ProximaState } from '../domain/types.js';
import { convergeAfterWrite } from './writeConvergence.js';
import type { RefreshReason, RefreshResult } from './refreshController.js';
import { mintSemanticRequestId, semanticOutcomeOf, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';
import { parseTemplatePlan } from './templateComposer.js';
import { executeTemplatePlan, type TemplateExecutionRefusal } from './templateExecution.js';
import type { CreateTaskRequest, TaskMutationResult } from './taskMutations.js';

export const TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION = 1 as const;

export type TemplateExecuteVerb = 'execute';

/** The operations the shell resolved, structurally: no store, no coordinator, no paths. */
export interface TemplateExecuteOperations {
  createTask(request: CreateTaskRequest): Promise<TaskMutationResult>;
}

export interface TemplateExecuteDependencies {
  readonly state: ProximaState | null;
  readonly writes: () => Promise<TemplateExecuteOperations | null>;
  readonly unavailableReason: () => string | null;
  readonly refresh: (reason: RefreshReason) => Promise<RefreshResult | null>;
  /** The refusal the surface will draw, or null to clear it. */
  readonly setRefusal: (reason: string | null) => void;
  readonly render: () => void;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes: the shell supplies the ring-backed sink. */
  readonly audit: SemanticAuditSink;
}

export interface TemplateExecuteRequest {
  readonly template: string;
  readonly projectId?: OpaqueRecordId | null;
}

export type TemplateExecuteFailureReason =
  | 'writes-unavailable'
  | 'plan-invalid'
  | 'untranslatable-draft-field'
  /** The port lost a race or refused a conflict: the same kind of answer, told apart from a plain refusal. */
  | 'semantic-conflict'
  /** The port could not write: a storage failure rather than a decision about the content. */
  | 'storage-failure'
  | 'creation-refused';

export type TemplateExecuteOutcome =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION;
      readonly verb: TemplateExecuteVerb;
      readonly outcome: 'created';
      /** This run's semantic request id: minted at the boundary, returned on every result. */
      readonly requestId: string;
      readonly created: readonly OpaqueRecordId[];
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION;
      readonly verb: TemplateExecuteVerb;
      readonly reason: TemplateExecuteFailureReason;
      readonly detail: string;
      /** This run's semantic request id: a refused run is correlatable too, which is the point of it. */
      readonly requestId: string;
      /** Empty for a refusal decided before the first call; the ids that did land otherwise. */
      readonly created: readonly OpaqueRecordId[];
      readonly refreshed: boolean;
    };

function refused(
  reason: TemplateExecuteFailureReason,
  detail: string,
  requestId: string,
  created: readonly OpaqueRecordId[] = [],
): TemplateExecuteOutcome {
  return {
    ok: false,
    schemaVersion: TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION,
    verb: 'execute',
    reason,
    detail,
    requestId,
    created: [...created],
    refreshed: false,
  };
}

/**
 * The reason a refused creation comes back with, taken from the port's own cause rather than flattened.
 *
 * The execution layer already carries the port's reason through as `cause`, and the comment on it says why:
 * a caller should be able to tell a lost race from a validation refusal without re-reading the store. That was
 * true of the port and not of this boundary, which collapsed every creation refusal into one word - so a lost
 * race and a failed write arrived at a surface identically, and the matrix recorded both cells as gaps with
 * this function as the reason. A conflict is the port saying the record moved (`stale-revision`) or that the
 * request contradicts what is stored (`semantic-conflict`); a storage failure is the port saying it could not
 * write at all. The remaining causes - a validation refusal, an unknown project, a record that is gone - are
 * ordinary refusals of the request, and stay `creation-refused`.
 */
function refusalReasonOf(refusal: TemplateExecutionRefusal): TemplateExecuteFailureReason {
  switch (refusal.reason) {
    case 'plan-invalid':
      return 'plan-invalid';
    case 'untranslatable-draft-field':
      return 'untranslatable-draft-field';
    default:
      break;
  }
  switch (refusal.cause) {
    case 'stale-revision':
    case 'semantic-conflict':
      return 'semantic-conflict';
    case 'storage-failure':
      return 'storage-failure';
    default:
      return 'creation-refused';
  }
}

/**
 * Submit a template for execution. The template text is parsed here rather than by the caller, so an
 * invalid template is refused by the same path that would have run it - and a caller cannot execute a plan
 * it built by hand.
 *
 * Two things every run leaves behind, ruled by the AUTHOR on 2026-09-12: a **semantic request id**, minted
 * here at the boundary before anything can refuse, so a refused run is correlatable as well as an accepted
 * one; and **one terminal audit event**, appended after convergence so the shell can journal the state
 * revision the surfaces have actually reached. The event distinguishes a partial run from both an acceptance
 * and a rejection, because reporting "one task landed and the second was refused" as either would be the lie
 * the panel rule exists to prevent.
 */
export async function executeTemplateAction(
  deps: TemplateExecuteDependencies,
  request: TemplateExecuteRequest,
): Promise<TemplateExecuteOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType: 'template.execute',
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  deps.setRefusal(null);
  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    deps.setRefusal(reason);
    deps.render();
    audit('rejected', [], 'writes-unavailable');
    return refused('writes-unavailable', reason, requestId);
  }

  const plan = parseTemplatePlan(request.template);
  const executed = await executeTemplatePlan({
    plan,
    tasks: operations,
    projectId: request.projectId ?? null,
  });

  const lostRace = executed.kind !== 'complete' && executed.refusal.cause === 'stale-revision';
  const created = executed.kind === 'refused' ? [] : executed.created;
  // Convergence is owed whenever the store changed, which is not the same as "the run succeeded": a partial
  // run has already written records, so leaving the surfaces stale would be the bug the panel rule is trying
  // to avoid. A refusal decided before the first call changes nothing, so it does not re-read - the rule
  // convergeAfterWrite documents for every other refusal.
  const wrote = executed.kind === 'complete' || created.length > 0;
  const convergence = await convergeAfterWrite(deps, { accepted: wrote, lostRace });
  const refreshed = convergence.refreshed;

  if (executed.kind === 'complete') {
    audit(semanticOutcomeOf({ wrote: created.length, refused: false }), executed.created);
    deps.render();
    return {
      ok: true,
      schemaVersion: TEMPLATE_EXECUTE_ACTION_SCHEMA_VERSION,
      verb: 'execute',
      outcome: 'created',
      requestId,
      created: [...executed.created],
      refreshed,
    };
  }

  const reason = refusalReasonOf(executed.refusal);
  audit(semanticOutcomeOf({ wrote: created.length, refused: true }), created, reason);
  deps.setRefusal(executed.refusal.detail);
  deps.render();
  return {
    ...refused(reason, executed.refusal.detail, requestId, created),
    refreshed,
  };
}
