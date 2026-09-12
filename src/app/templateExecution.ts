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
import { parseOpaqueRecordId, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { PropertySchema } from '../domain/types.js';
import { planPropertyMutation } from './propertyMutationPlan.js';
import type { TaskCreateOperations } from './taskCreate.js';
import type { CreateTaskRequest, TaskFieldMutation, TaskMutationResult } from './taskMutations.js';
import type { TemplateComposerError, TemplatePlan, TemplateTaskDraft } from './templateComposer.js';

export const TEMPLATE_EXECUTION_SCHEMA_VERSION = 1 as const;

export type TemplateExecutionRefusalReason =
  | 'plan-invalid'
  | 'untranslatable-draft-field'
  | 'creation-refused'
  | 'relation-update-refused';

export interface TemplateExecutionRefusal {
  readonly reason: TemplateExecutionRefusalReason;
  /** One bounded sentence, safe to show. */
  readonly detail: string;
  /** Present when the refusal belongs to one draft, so a reader can point at the line. */
  readonly line?: number;
  readonly name?: string;
  /**
   * The port's own reason, when the refusal came from a creation rather than from the plan. Carried rather
   * than flattened so a caller can tell a lost race ('stale-revision') from a validation refusal without
   * re-reading the store - the write-action layer above needs exactly that distinction.
   */
  readonly cause?: string;
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
  /**
   * The ordinary task operations. Existing callers that execute templates with no local relations
   * need only create; a plan that contains a relation is refused before creation unless updateTask
   * is present.
   */
  readonly tasks: TaskCreateOperations & {
    readonly updateTask?: (input: {
      readonly taskId: OpaqueRecordId;
      readonly expectedRevision: string;
      readonly mutations: readonly TaskFieldMutation[];
    }) => Promise<TaskMutationResult>;
  };
  /** The task-property schemas the caller read for this execution. */
  readonly schemas?: readonly PropertySchema[];
  /** The project a created task belongs to, when the template is being run inside one. */
  readonly projectId?: OpaqueRecordId | null;
}

/**
 * The ordinary draft fields whose canonical meaning is still not this module's to choose.
 *
 * Template properties are handled separately: D86 gives one and only one property form an executable
 * meaning here — a relation schema whose value consists entirely of template-local `@N` references.
 */
const UNTRANSLATABLE_FIELDS = ['status', 'isCompleted'] as const;

interface PlannedTemplateRelation {
  readonly sourceIndex: number;
  readonly schema: PropertySchema;
  readonly targetIndexes: readonly number[];
  readonly line: number;
  readonly name: string;
}

type TemplateRelationPlan =
  | { readonly ok: true; readonly relations: readonly PlannedTemplateRelation[] }
  | { readonly ok: false; readonly refusal: TemplateExecutionRefusal };

function refusalForField(draft: TemplateTaskDraft): TemplateExecutionRefusal | null {
  for (const field of UNTRANSLATABLE_FIELDS) {
    if (draft[field] !== null) {
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

/** D86's `@N` vocabulary, resolved only after every create has returned its canonical id. */
function templateRelationIndexes(
  value: string,
  taskCount: number,
): { readonly ok: true; readonly indexes: readonly number[] } | { readonly ok: false; readonly detail: string } {
  const tokens = value.split(',').map((token) => token.trim());
  const indexes: number[] = [];
  const seen = new Set<number>();

  for (const token of tokens) {
    const match = /^@([1-9]\d*)$/.exec(token);
    if (match === null) {
      return { ok: false, detail: `a template relation target is @N, not "${token}"` };
    }

    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > taskCount) {
      return { ok: false, detail: `${token} does not name one of this template's ${taskCount} task(s)` };
    }

    const index = ordinal - 1;
    if (seen.has(index)) {
      return { ok: false, detail: `${token} is named more than once in the same relation` };
    }

    seen.add(index);
    indexes.push(index);
  }

  return { ok: true, indexes };
}

/**
 * Decide every local relation before the first write.
 *
 * This is also where a property that is not a relation is refused: D86 does not turn template
 * property text into a second general-purpose property form.
 */
function planTemplateRelations(
  tasks: readonly TemplateTaskDraft[],
  schemas: readonly PropertySchema[],
): TemplateRelationPlan {
  const relations: PlannedTemplateRelation[] = [];

  for (const [sourceIndex, draft] of tasks.entries()) {
    for (const [schemaId, value] of Object.entries(draft.properties)) {
      const schema = schemas.find((candidate) => candidate.id === schemaId);
      if (schema === undefined) {
        return {
          ok: false,
          refusal: {
            reason: 'untranslatable-draft-field',
            detail: `property.${schemaId} has no schema record this template can translate`,
            line: draft.line,
            name: draft.name,
          },
        };
      }

      if (schema.type !== 'relation') {
        return {
          ok: false,
          refusal: {
            reason: 'untranslatable-draft-field',
            detail: `property.${schemaId} is ${schema.type}; template property values are executable here only when the schema is relation`,
            line: draft.line,
            name: draft.name,
          },
        };
      }

      try {
        parseOpaqueRecordId(schema.id);
      } catch {
        return {
          ok: false,
          refusal: {
            reason: 'untranslatable-draft-field',
            detail: `property.${schemaId} is not a canonical relation-schema id`,
            line: draft.line,
            name: draft.name,
          },
        };
      }

      const targets = templateRelationIndexes(value, tasks.length);
      if (!targets.ok) {
        return {
          ok: false,
          refusal: {
            reason: 'plan-invalid',
            detail: targets.detail,
            line: draft.line,
            name: draft.name,
          },
        };
      }

      relations.push({
        sourceIndex,
        schema,
        targetIndexes: targets.indexes,
        line: draft.line,
        name: draft.name,
      });
    }
  }

  return { ok: true, relations };
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

  const relationPlan = planTemplateRelations(plan.tasks, options.schemas ?? []);
  if (!relationPlan.ok) {
    return {
      kind: 'refused',
      schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
      refusal: relationPlan.refusal,
    };
  }

  if (relationPlan.relations.length > 0 && tasks.updateTask === undefined) {
    return {
      kind: 'refused',
      schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
      refusal: {
        reason: 'untranslatable-draft-field',
        detail: 'this template contains local relations, but this caller has no task-update operation to resolve them',
      },
    };
  }

  const created: OpaqueRecordId[] = [];
  const createdRevisions: string[] = [];

  for (const draft of plan.tasks) {
    const request = toCreateTaskRequest(draft, projectId);
    const result = await tasks.createTask(request);
    if (!result.ok) {
      const refusal: TemplateExecutionRefusal = {
        reason: 'creation-refused',
        detail: result.detail,
        line: draft.line,
        name: draft.name,
        cause: result.reason,
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
    createdRevisions.push(result.revision);
  }

  const sourceIndexes = [...new Set(relationPlan.relations.map((relation) => relation.sourceIndex))].sort((left, right) => left - right);

  for (const sourceIndex of sourceIndexes) {
    const sourceRelations = relationPlan.relations.filter((relation) => relation.sourceIndex === sourceIndex);
    const mutations: TaskFieldMutation[] = [];

    for (const relation of sourceRelations) {
      const targetIds = relation.targetIndexes.map((targetIndex) => created[targetIndex]!);
      const planned = planPropertyMutation(relation.schema, {
        value: targetIds.join(', '),
        checked: false,
        selected: [],
      });

      if (!planned.ok) {
        return {
          kind: 'partial',
          schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
          created: [...created],
          refusal: {
            reason: 'relation-update-refused',
            detail: planned.detail,
            line: relation.line,
            name: relation.name,
            cause: planned.reason,
          },
        };
      }

      mutations.push({
        kind: 'property',
        key: parseOpaqueRecordId(relation.schema.id),
        value: planned.value,
      });
    }

    const result = await tasks.updateTask!({
      taskId: created[sourceIndex]!,
      expectedRevision: createdRevisions[sourceIndex]!,
      mutations,
    });

    if (!result.ok) {
      const draft = plan.tasks[sourceIndex]!;
      return {
        kind: 'partial',
        schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION,
        created: [...created],
        refusal: {
          reason: 'relation-update-refused',
          detail: result.detail,
          line: draft.line,
          name: draft.name,
          cause: result.reason,
        },
      };
    }
  }

  return { kind: 'complete', schemaVersion: TEMPLATE_EXECUTION_SCHEMA_VERSION, created };
}
