import {
  PROBLEM_CODES,
  type LoadProblem,
  type ProblemCode,
} from '../domain/problems.js';

export const DIAGNOSTIC_CODES = [
  ...PROBLEM_CODES,
  'refresh-failed',
  'renderer-failure',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
export type SourceDiagnosticCode = ProblemCode | 'refresh-failed';

export const DIAGNOSTIC_LIMITS = {
  problems: 100,
  problemCodes: 20,
  problemPath: 260,
  problemId: 400,
  problemDetail: 400,
  rendererDetail: 180,
} as const;

export function boundDiagnosticProblem(
  problem: LoadProblem,
): LoadProblem {
  const bounded: LoadProblem = {
    ...problem,
    path: problem.path.slice(0, DIAGNOSTIC_LIMITS.problemPath),
    detail: problem.detail.slice(0, DIAGNOSTIC_LIMITS.problemDetail),
  };

  if (bounded.id !== undefined) {
    bounded.id = bounded.id.slice(0, DIAGNOSTIC_LIMITS.problemId);
  }

  return bounded;
}

export function boundDiagnosticProblems(
  problems: readonly LoadProblem[],
): LoadProblem[] {
  return problems
    .slice(0, DIAGNOSTIC_LIMITS.problems)
    .map(boundDiagnosticProblem);
}

const DIAGNOSTIC_CODE_SET = new Set<string>(DIAGNOSTIC_CODES);

export function isDiagnosticCode(
  value: unknown,
): value is DiagnosticCode {
  return typeof value === 'string'
    && DIAGNOSTIC_CODE_SET.has(value);
}
