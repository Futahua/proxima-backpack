import {
  PROBLEM_CODES,
  type ProblemCode,
} from '../domain/problems.js';

export const DIAGNOSTIC_CODES = [
  ...PROBLEM_CODES,
  'refresh-failed',
  'renderer-failure',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
export type SourceDiagnosticCode = ProblemCode | 'refresh-failed';

const DIAGNOSTIC_CODE_SET = new Set<string>(DIAGNOSTIC_CODES);

export function isDiagnosticCode(
  value: unknown,
): value is DiagnosticCode {
  return typeof value === 'string'
    && DIAGNOSTIC_CODE_SET.has(value);
}
