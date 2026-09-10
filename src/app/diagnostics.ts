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

const REDACTED_DIAGNOSTIC_SECRET = '[redacted]';

const AUTHORIZATION_CREDENTIAL =
  /(\bauthorization\b["']?\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;&}\r\n]+/gi;

const NAMED_CREDENTIAL =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi;

const URI_USERINFO_CREDENTIAL =
  /([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^@\/\s]+@/gi;

const STANDALONE_CREDENTIAL = new RegExp(
  String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`,
  'g',
);

export function redactDiagnosticSecrets(
  value: string,
): string {
  return value
    .replace(
      AUTHORIZATION_CREDENTIAL,
      `$1${REDACTED_DIAGNOSTIC_SECRET}`,
    )
    .replace(
      NAMED_CREDENTIAL,
      `$1${REDACTED_DIAGNOSTIC_SECRET}`,
    )
    .replace(
      URI_USERINFO_CREDENTIAL,
      `$1${REDACTED_DIAGNOSTIC_SECRET}@`,
    )
    .replace(
      STANDALONE_CREDENTIAL,
      REDACTED_DIAGNOSTIC_SECRET,
    );
}

const QUOTED_ABSOLUTE_MACHINE_PATH =
  /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`\r\n]+)\1/g;

const WINDOWS_ABSOLUTE_MACHINE_PATH =
  /(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s,;"'`<>(){}\[\]]+/g;

const POSIX_ABSOLUTE_MACHINE_PATH =
  /(^|[\s=: ("'`])\/(?:[^\/\s,;"'`<>(){}\[\]]+\/)+[^\/\s,;"'`<>(){}\[\]]+/gm;

export function redactDiagnosticMachinePaths(
  value: string,
): string {
  return value
    .replace(
      QUOTED_ABSOLUTE_MACHINE_PATH,
      (_match: string, quote: string) =>
        `${quote}${REDACTED_DIAGNOSTIC_SECRET}${quote}`,
    )
    .replace(
      WINDOWS_ABSOLUTE_MACHINE_PATH,
      REDACTED_DIAGNOSTIC_SECRET,
    )
    .replace(
      POSIX_ABSOLUTE_MACHINE_PATH,
      (_match: string, prefix: string) =>
        `${prefix}${REDACTED_DIAGNOSTIC_SECRET}`,
    );
}

export function redactDiagnosticDisclosure(
  value: string,
): string {
  return redactDiagnosticMachinePaths(
    redactDiagnosticSecrets(value),
  );
}

function redactDiagnosticPath(
  value: string,
): string {
  const normalized = value.replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:\/|\/\/|\/)/.test(normalized)) {
    return REDACTED_DIAGNOSTIC_SECRET;
  }
  return redactDiagnosticDisclosure(value);
}

export function redactDiagnosticProblem(
  problem: LoadProblem,
): LoadProblem {
  const redacted: LoadProblem = {
    ...problem,
    path: redactDiagnosticPath(problem.path),
    detail: redactDiagnosticDisclosure(problem.detail),
  };

  if (redacted.id !== undefined) {
    redacted.id = redactDiagnosticDisclosure(redacted.id);
  }

  return redacted;
}

export function boundDiagnosticProblem(
  problem: LoadProblem,
): LoadProblem {
  const redacted = redactDiagnosticProblem(problem);
  const bounded: LoadProblem = {
    ...redacted,
    path: redacted.path.slice(0, DIAGNOSTIC_LIMITS.problemPath),
    detail: redacted.detail.slice(0, DIAGNOSTIC_LIMITS.problemDetail),
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
