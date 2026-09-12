/**
 * Executing a parsed template plan, as the AUTHOR scoped it on 2026-09-12.
 *
 * What this module is: the missing half of Stage 16. The parser already turns template text into a typed
 * `TemplatePlan`; this turns that plan into the **same** task-creation requests the rest of the product
 * uses, through an injected port, and reports what happened.
 *
 * What it deliberately is not:
 *
 * - **No RecordStore, directly or indirectly.** The only way out of this module is `TaskCreateOperations`,
 *   which is the seam the UI already calls. That is what keeps a template from being a second write path
 *   with its own authority; `tests/templateExecution.test.ts` asserts the absence by reading this file.
 * - **No id allocation of its own.** A created task's id comes back from the port (`recordId`), so nothing
 *   here invents identity, and there is no allocation table to get wrong. It becomes necessary only when
 *   cross-record references arrive, together with a parser-validated template-local id.
 * - **No field mapping it cannot justify.** A draft's `status` is free text and `isCompleted` is a boolean,
 *   while the canonical request takes an `executionState` of backlog/running/finished. Choosing that
 *   correspondence is a semantic decision this module has no authority to make, so a draft that sets
 *   either one **refuses the whole batch before the first action** rather than silently dropping the field
 *   the template author asked for.
 *
 * Refusal is always all-or-nothing and always before the first call; once one creation has succeeded, a
 * later refusal is reported as `partial` and never as `complete`.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { TaskCreateOperations } from './taskCreate.js';
import type { CreateTaskRequest } from './taskMutations.js';
import type { TemplateComposerError, TemplatePlan, TemplateTaskDraft } from './templateComposer.js';

export const TEMPLATE_EXECUTION_SCHEMA_VERSION = 1 as const;

export type TemplateExecutionRefusalReason =
  | 'plan-invalid'
  | 'untranslatable-draft-field'
  | 'creation-refused';

export interface TemplateExecutionRefusal {
  readonly reason: TemplateExecutionRefusalReason;
  /** One bounded sentence, safe to show. */
  readonly detail: string;
  /** Present when the refusal belongs to one draft, so a reader can point at the line. */
  readonly line?: number;
  readonly name?: string;
}

export type TemplateExecutionOutcome =
  | {
      readonly kind: 'complete';
      readonly schemaVersion: typeof TEMPLATE_EXECUTION_SCHEMA_VERSION;
      readonly created: readonly OpaqueRecordId[];
    }
  | {
      readonly kind: 'refused';
      readonly schemaVersion: typeof TEMPLATE_EXECUTION_SCHEMA_VERSION;
      readonly refusal: TemplateExecutionRefusal;
    }
  | {
      readonly kind: 'partial';
      readonly schemaVersion: typeof TEMPLATE_EXECUTION_SCHEMA_VERSION;
      readonly created: readonly OpaqueRecordId[];
      readonly refusal: TemplateExecutionRefusal;
    };

export interface TemplateExecutionOptions {
  readonly plan: TemplatePlan;
  /** The port. The only way out of this module. */
  readonly tasks: TaskCreateOperations;
  /** The project a created task belongs to, when the template is being run inside one. */
  readonly projectId?: OpaqueRecordId | null;

}

/**
 * The draft fields whose canonical meaning is not this module's to choose.
 *
 * `status` is free text and `completed` is a boolean, while the request takes an `executionState` of
 * backlog/running/finished. `property.<key>` arrives as a plain string, while a stored property value is a
 * `CanonicalStoredPropertyValue` - a richer shape whose correspondence to a line of template text is a
 * decision nobody has made yet. Refusing is the only honest option: the alternative is running a template
 * with a field silently dropped.
 */
const UNTRANSLATABLE_FIELDS = ['status', 'isCompleted', 'properties'] as const;



function refusalForField(draft: TemplateTaskDraft): TemplateExecutionRefusal | null {
  for (const field of UNTRANSLATABLE_FIELDS) {
    const value = field === 'properties' ? Object.keys(draft.properties).length : draft[field];
    const set = field === 'properties' ? (value as number) > 0 : value !== null;
    if (set) {
      return {
        reason: 'untranslatable-draft-field',
        detail: `"${field}" has no canonical equivalent yet, so this template is refused rather than run with the field dropped`,
        line: draft.line,
        name: draft.name,
      };
    }
  }
  return null;
}

/** The draft, as the create request the rest of the product uses. Only fields with a decided meaning. */
export function toCreateTaskRequest(
  draft: TemplateTaskDraft,
  projectId: OpaqueRecordId | null,
): CreateTaskRequest {
  return {
    name: draft.name,
    projectId,
    ...(draft.weight !== null ? { weight: draft.weight } : {}),
    startDate: draft.startDate,
    deadline: draft.deadline,
    ...(draft.fixedDuration !== null
      ? { isFixedDuration: true, fixedDuration: draft.fixedDuration }
      : {}),
    ...(draft.maxDuration !== null ? { maxDuration: draft.maxDuration } : {}),
  };
}

function planInvalid(errors: readonly TemplateComposerError[]): TemplateExecutionRefusal {
  const first = errors[0];
  return {
    reason: 'plan-invalid',
    detail: first
      ? `the template did not parse: ${first.code} on line ${first.line}`
      : 'the template did not parse',
    ...(first ? { line: first.line } : {}),
  };
}

/**
 * Execute a parsed plan. Every refusal that can be decided from the plan alone is decided before the first
 * creation, so an invalid plan performs zero calls - which is a claim the tests check with a counting port
 * rather than by inspection.
 */
export async function executeTemplatePlan(
  options: TemplateExecutionOptions,
): Promise<TemplateExecutionOutcome> {
  const { plan, tasks } = options;
  const projectId = options.projectId ?? null;

  if (plan.errors.length > 0) {
    return {
      kind: 'refused',
      schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
      refusal: planInvalid(plan.errors),
    };
  }

  for (const draft of plan.tasks) {
    const refusal = refusalForField(draft);
    if (refusal) {
      return { kind: 'refused', schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION, refusal };
    }
  }

  const created: OpaqueRecordId[] = [];
  for (const draft of plan.tasks) {
    const request = toCreateTaskRequest(draft, projectId);
    const result = await tasks.createTask(request);
    if (!result.ok) {
      const refusal: TemplateExecutionRefusal = {
        reason: 'creation-refused',
        detail: result.detail,
        line: draft.line,
        name: draft.name,
      };
      if (created.length === 0) {
        return { kind: 'refused', schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION, refusal };
      }
      return {
        kind: 'partial',
        schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
        created: [...created],
        refusal,
      };
    }
    created.push(result.recordId);
  }

  return { kind: 'complete', schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION, created };
}
