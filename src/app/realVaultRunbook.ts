import { isRealVaultAcceptanceReport, type AcceptanceStageName, type RealVaultAcceptanceReport } from './realVaultAcceptance.js';

export const REAL_VAULT_RUNBOOK_SCHEMA_VERSION = 1 as const;
export type RunbookStatus = 'READY' | 'BLOCKED' | 'ABORTED';

export interface RealVaultRunbookInput {
  report: RealVaultAcceptanceReport;
  expectedBuildSha?: string;
  expectedRoot?: string;
  nativeSelectionCompleted?: boolean;
}

export interface RealVaultRunbookReport {
  schemaVersion: typeof REAL_VAULT_RUNBOOK_SCHEMA_VERSION;
  status: RunbookStatus;
  ready: boolean;
  preconditions: Array<{ code: string; passed: boolean }>;
  evidencePlan: Array<{ stage: Exclude<AcceptanceStageName, 'overall'>; required: boolean; verdict: string }>;
  abortCodes: string[];
  zeroWrite: { passed: boolean; writesAttempted: number; writerMethodsCalled: string[] };
  nativeBoundary: 'select-and-grant' | 'none';
}

const MAX = 20;
function bounded(values: string[]): string[] { return [...new Set(values.map((value) => String(value).slice(0, 100)))].slice(0, MAX); }
function rootMatches(report: RealVaultAcceptanceReport, expectedRoot: string | undefined): boolean {
  if (!expectedRoot) return true;
  const root = expectedRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return report.sourceRevisions.length > 0 && report.sourceRevisions.every((entry) => entry.path === root || entry.path.startsWith(`${root}/`));
}

/** Pure preflight/runbook guard. It never selects, opens, reads, writes, or requests permission. */
export function evaluateRealVaultRunbook(input: RealVaultRunbookInput): RealVaultRunbookReport {
  const report = input.report;
  if (!isRealVaultAcceptanceReport(report)) throw new Error('invalid-real-vault-acceptance-report');
  const preconditions = [
    { code: 'external-source', passed: report.sourceMode === 'external' },
    { code: 'permission-granted', passed: report.restoredHandlePresent && report.bootstrapStatus === 'ready' },
    { code: 'stable-session', passed: report.transitionState === 'stable' },
    { code: 'healthy-baseline', passed: report.stages.baselineRead.verdict === 'PASS' && report.health.status === 'healthy' },
    { code: 'build-identity', passed: input.expectedBuildSha === undefined || report.build.gitSha === input.expectedBuildSha },
    { code: 'expected-root', passed: rootMatches(report, input.expectedRoot) },
    { code: 'provenance-present', passed: report.provenanceSamples.length > 0 },
    { code: 'zero-write', passed: report.stages.writeInvariant.verdict === 'PASS' && report.writeInvariant.writesAttempted === 0 && report.writeInvariant.writerMethodsCalled.length === 0 },
  ];
  const abortCodes = bounded(preconditions.filter((check) => !check.passed).map((check) => check.code));
  if (report.health.degraded || report.health.stale) abortCodes.push('stale-or-degraded');
  const status: RunbookStatus = abortCodes.length > 0 ? (report.writeInvariant.writesAttempted > 0 || report.writeInvariant.writerMethodsCalled.length > 0 ? 'ABORTED' : 'BLOCKED') : 'READY';
  const stages: Array<Exclude<AcceptanceStageName, 'overall'>> = ['baselineRead', 'externalEdit', 'renameDelete', 'obsidianCoexistence', 'writeInvariant'];
  return {
    schemaVersion: REAL_VAULT_RUNBOOK_SCHEMA_VERSION,
    status,
    ready: status === 'READY',
    preconditions,
    evidencePlan: stages.map((stage) => ({ stage, required: stage !== 'obsidianCoexistence', verdict: report.stages[stage].verdict })),
    abortCodes: bounded(abortCodes),
    zeroWrite: { passed: report.writeInvariant.writesAttempted === 0 && report.writeInvariant.writerMethodsCalled.length === 0, writesAttempted: Math.max(0, Math.min(report.writeInvariant.writesAttempted, 100)), writerMethodsCalled: report.writeInvariant.writerMethodsCalled.slice(0, MAX).map((method) => String(method).slice(0, 100)) },
    nativeBoundary: input.nativeSelectionCompleted || report.sourceMode === 'external' ? 'none' : 'select-and-grant',
  };
}

export function isRealVaultRunbookReport(value: unknown): value is RealVaultRunbookReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RealVaultRunbookReport>;
  return candidate.schemaVersion === REAL_VAULT_RUNBOOK_SCHEMA_VERSION && (candidate.status === 'READY' || candidate.status === 'BLOCKED' || candidate.status === 'ABORTED') && typeof candidate.ready === 'boolean' && Array.isArray(candidate.preconditions) && Array.isArray(candidate.evidencePlan) && Array.isArray(candidate.abortCodes);
}
