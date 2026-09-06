/**
 * Structured load problems.
 *
 * A problem is a machine-readable fact about a file the reader could not fully or
 * safely interpret. The rule this type enforces is that nothing is dropped quietly:
 * a record either enters state, or a problem says why it did not.
 *
 * Codes are stable identifiers, not prose. The prose lives in `detail` and may change
 * freely; a consumer matches on `code`.
 */
import type { RecordKind } from './records.js';
import type { FieldIssueCode } from './validation.js';

export type ProblemSeverity =
  /** The record did not enter state. */
  | 'error'
  /** The record entered state, but something about the source needs saying. */
  | 'warning';

export type ProblemCode =
  /** The file could not be read at all. */
  | 'unreadable'
  /** A directory the layout names could not be listed. */
  | 'directory-unreadable'
  /** Two records of the same kind resolved to the same logical id. */
  | 'duplicate-id'
  /** Markdown sat somewhere the discovery rule does not read records from. */
  | 'ignored-file'
  /** Frontmatter declared a `type` that contradicts the directory it sits in. */
  | 'unexpected-type'
  /** Frontmatter used YAML outside the supported subset; the key was left unset. */
  | 'unsupported-frontmatter'
  /** A date field could not be interpreted. */
  | 'bad-date'
  /** A numeric field was unreadable or outside the range the field allows. */
  | 'bad-number'
  /** A boolean field held something that is not true or false. */
  | 'bad-boolean'
  /** A status field held something that is not a usable identifier. */
  | 'invalid-status'
  /** A closed-vocabulary field held a value outside its allowed set. */
  | 'invalid-enum'
  /** A record referenced a project id that no loaded project has. */
  | 'missing-project'
  /** A finite calendar event span exceeds the bounded expansion contract. */
  | 'event-span-too-large';

export interface LoadProblem {
  code: ProblemCode;
  severity: ProblemSeverity;
  /** Vault-relative path of the file the problem is about. */
  path: string;
  /** What the reader was trying to load, when that is known. */
  kind?: RecordKind;
  /** The logical id involved, when one had already been resolved. */
  id?: string;
  detail: string;
}

export function isBlocking(problem: LoadProblem): boolean {
  return problem.severity === 'error';
}

/** The problem code a field-level validation issue reports as. */
export function problemCodeForField(code: FieldIssueCode): ProblemCode {
  if (code === 'invalid-date') return 'bad-date';
  if (code === 'not-a-boolean') return 'bad-boolean';
  if (code === 'invalid-status') return 'invalid-status';
  if (code === 'invalid-enum') return 'invalid-enum';
  return 'bad-number';
}

export function problemsFor(problems: LoadProblem[], code: ProblemCode): LoadProblem[] {
  return problems.filter((p) => p.code === code);
}

/**
 * Whether a problem must block a real-vault baseline.
 *
 * The acceptance evaluator previously failed a baseline whenever *any* problem was
 * present. A creator vault of any size carries at least one benign warning — a
 * stray `type:` on a note, a field the reader chose not to interpret — so that rule
 * made a real baseline close to unreachable, and would have rejected a healthy
 * vault for a reason that is not a defect.
 *
 * Severity is the distinction the reader already makes, so acceptance consumes it
 * rather than inventing a numeric allowance or an operator-declared tolerance. Both
 * of those would let unknown problem classes be blessed into a pass.
 *
 * Unknown or missing severity fails closed. A problem this function cannot classify
 * is not evidence of health; treating it as a warning would make every future
 * severity added elsewhere silently non-blocking here.
 */
export function blocksBaseline(problem: { severity?: unknown }): boolean {
  return problem?.severity !== 'warning';
}
