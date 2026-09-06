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
  /** A record referenced a project id that no loaded project has. */
  | 'missing-project';

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
  return 'bad-number';
}

export function problemsFor(problems: LoadProblem[], code: ProblemCode): LoadProblem[] {
  return problems.filter((p) => p.code === code);
}
