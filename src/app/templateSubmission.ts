/**
 * The agent-facing submission entry for template execution.
 *
 * The AUTHOR ruled on 2026-09-12 that this is a **sibling entry, not a `ProximaAction`**: the protocol's
 * `dispatch()` is deliberately synchronous and generates its own requestId, and forcing one asynchronous,
 * multi-record template operation through it would change the execution model of every unrelated action.
 * So this module owns the outer wire shape, validates it, and hands the work to `executeTemplateAction` -
 * which is also what the panel Confirm will call, so an agent and a surface cannot drift apart.
 *
 * Two deliberate narrownesses:
 *
 * - **Only the outer shape is validated here.** Whether the template itself parses, and whether a draft can
 *   be translated, are the execution layer's answers and come back as its refusals rather than as a second
 *   implementation of those rules.
 * - **No caller-supplied requestId.** Correlation stays where it already is, generated inside the execution
 *   and write machinery, so an agent cannot claim an id the machinery did not issue.
 *
 * What this closes is the "agent without a modal" boundary: the first test submits through this entry with
 * no panel or modal object anywhere in the dependency set, and the records are created.
 */
import { parseOpaqueRecordId, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  executeTemplateAction,
  type TemplateExecuteDependencies,
  type TemplateExecuteOutcome,
} from './templateExecuteAction.js';

/** The wire shape an agent submits. */
export interface TemplateExecuteSubmission {
  readonly type: 'template.execute';
  readonly template: string;
  /**
   * The project to create into, as a canonical opaque record id.
   *
   * The parsed shape carries the branded id rather than a string, because the parser is where it is validated:
   * a caller that has one of these has already had the identity checked, so nothing downstream casts.
   */
  readonly projectId?: OpaqueRecordId;
}

export type TemplateSubmissionFailureReason = 'malformed-submission';

export type TemplateSubmissionResult =
  | TemplateExecuteOutcome
  | {
      readonly ok: false;
      readonly reason: TemplateSubmissionFailureReason;
      readonly detail: string;
    };

function rejected(detail: string): TemplateSubmissionResult {
  return { ok: false, reason: 'malformed-submission', detail };
}

/**
 * Validate the outer wire shape only. Returns the parsed submission or the sentence explaining what is
 * wrong with it - a caller that is an agent needs the sentence, not an exception.
 */
export function parseTemplateExecuteSubmission(
  input: unknown,
): { readonly ok: true; readonly submission: TemplateExecuteSubmission } | { readonly ok: false; readonly detail: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, detail: 'a template submission is an object' };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.type !== 'template.execute') {
    return { ok: false, detail: 'the submission type must be template.execute' };
  }
  if (typeof candidate.template !== 'string') {
    return { ok: false, detail: 'the submission needs a template string' };
  }
  if (candidate.projectId !== undefined && typeof candidate.projectId !== 'string') {
    return { ok: false, detail: 'a projectId, when given, is a string' };
  }
  // The string check above is the shape; this is the identity. A project id is a **canonical opaque record
  // id**, and validating it here is what stops a cast from turning an arbitrary string into a reference that
  // reaches the store: the field used to be checked as a string and then cast, which the matrix recorded as
  // this row's runtime-validation gap in the AUTHOR's own words. The sentence names what was given, because a
  // caller that sent a folder name should be told that rather than that its id was malformed.
  let projectId: OpaqueRecordId | undefined;
  if (candidate.projectId !== undefined) {
    try {
      projectId = parseOpaqueRecordId(candidate.projectId as string);
    } catch {
      return { ok: false, detail: `a projectId is a canonical opaque record id, not ${String(candidate.projectId)}` };
    }
  }
  return {
    ok: true,
    submission: {
      type: 'template.execute',
      template: candidate.template,
      ...(projectId === undefined ? {} : { projectId }),
    },
  };
}

/** Submit a template for execution on behalf of an agent, through the same path a surface will use. */
export async function submitTemplateExecution(
  deps: TemplateExecuteDependencies,
  input: unknown,
): Promise<TemplateSubmissionResult> {
  const parsed = parseTemplateExecuteSubmission(input);
  if (!parsed.ok) return rejected(parsed.detail);
  const { template, projectId } = parsed.submission;
  return await executeTemplateAction(deps, {
    template,
    projectId: projectId ?? null,
  });
}
