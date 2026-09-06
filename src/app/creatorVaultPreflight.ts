import { isRealVaultAcceptanceReport, type RealVaultAcceptanceReport } from './realVaultAcceptance.js';
import { isRealVaultRunbookReport, type RealVaultRunbookReport } from './realVaultRunbook.js';

export const CREATOR_VAULT_PREFLIGHT_SCHEMA_VERSION = 1 as const;
export type CreatorVaultPreflightStatus = 'READY_FOR_NATIVE_GRANT' | 'BLOCKED' | 'ABORTED';

export interface CreatorVaultPreflightInput {
  acceptance: RealVaultAcceptanceReport;
  runbook: RealVaultRunbookReport;
  coexistence: { passed: boolean; zeroWrites: boolean; sourceBoundsValid: boolean; hostCapabilityResolved: boolean };
  expectedBuildSha: string;
}

export interface CreatorVaultPreflightReport {
  schemaVersion: typeof CREATOR_VAULT_PREFLIGHT_SCHEMA_VERSION;
  status: CreatorVaultPreflightStatus;
  ready: boolean;
  build: { gitSha: string; proximaVersion: string };
  sourceMode: 'fixture' | 'external';
  readOnly: true;
  zeroWriteInvariant: boolean;
  stages: { acceptance6J: string; runbook6L: string; coexistence6M: string; cleanProfileFsa: 'OPEN'; realObsidian: 'OPEN' };
  blockerCodes: string[];
  nativeAction: 'select/grant creator vault read-only directory' | 'none';
  forbiddenOperations: string[];
}

const MAX_CODES = 20;
const FORBIDDEN = ['writes', 'migration', 'autofix', 'native-watcher-assumptions', 'Papers-host-changes'];
function boundedCodes(values: string[]): string[] { return [...new Set(values.map((value) => value.slice(0, 100)))].slice(0, MAX_CODES); }
function safePath(path: string): boolean { const normalized = path.replaceAll('\\', '/'); return !/^(?:[A-Za-z]:|\/)/.test(normalized) && !normalized.split('/').some((part) => part === '..' || part === '.'); }
function pathsSafe(report: RealVaultAcceptanceReport): boolean { return report.sourceRevisions.every((entry) => safePath(entry.path)) && report.provenanceSamples.every((sample) => safePath(sample.relativeSourcePath)); }

/** Pure final composition. It consumes bounded reports only and has no native or source authority. */
export function evaluateCreatorVaultPreflight(input: CreatorVaultPreflightInput): CreatorVaultPreflightReport {
  const report = input.acceptance;
  const blockers: string[] = [];
  if (!isRealVaultAcceptanceReport(report)) blockers.push('acceptance-invalid');
  if (!isRealVaultRunbookReport(input.runbook)) blockers.push('runbook-invalid');
  if (report && report.build.gitSha !== input.expectedBuildSha) blockers.push('build-mismatch');
  if (!report || report.stages.baselineRead.verdict !== 'PASS') blockers.push('runbook-not-ready');
  if (!input.runbook || input.runbook.status !== 'READY') blockers.push(input.runbook?.status === 'ABORTED' ? 'runbook-not-ready' : 'runbook-not-ready');
  const zeroWrites = !!report && report.writeInvariant.writesAttempted === 0 && report.writeInvariant.writerMethodsCalled.length === 0 && input.runbook?.zeroWrite.passed === true && input.coexistence.zeroWrites;
  if (!zeroWrites) blockers.push('write-invariant-failed');
  if (!input.coexistence.passed) blockers.push('coexistence-simulation-missing');
  if (!input.coexistence.sourceBoundsValid || !report || !pathsSafe(report)) blockers.push('path-safety-failed');
  if (!input.coexistence.hostCapabilityResolved) blockers.push('host-capability-unresolved');
  const unique = boundedCodes(blockers);
  const aborted = unique.includes('write-invariant-failed') && !!report && report.writeInvariant.writesAttempted > 0;
  const status: CreatorVaultPreflightStatus = unique.length === 0 ? 'READY_FOR_NATIVE_GRANT' : aborted ? 'ABORTED' : 'BLOCKED';
  return {
    schemaVersion: CREATOR_VAULT_PREFLIGHT_SCHEMA_VERSION,
    status,
    ready: status === 'READY_FOR_NATIVE_GRANT',
    build: { gitSha: report?.build.gitSha?.slice(0, 260) ?? '', proximaVersion: report?.build.proximaVersion?.slice(0, 100) ?? '' },
    sourceMode: report?.sourceMode === 'external' ? 'external' : 'fixture',
    readOnly: true,
    zeroWriteInvariant: zeroWrites,
    stages: { acceptance6J: report?.stages.overall.verdict ?? 'FAIL', runbook6L: input.runbook?.status ?? 'BLOCKED', coexistence6M: input.coexistence.passed ? 'PASS' : 'OPEN', cleanProfileFsa: 'OPEN', realObsidian: 'OPEN' },
    blockerCodes: unique,
    nativeAction: status === 'READY_FOR_NATIVE_GRANT' ? 'select/grant creator vault read-only directory' : 'none',
    forbiddenOperations: FORBIDDEN.slice(),
  };
}

export function isCreatorVaultPreflightReport(value: unknown): value is CreatorVaultPreflightReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CreatorVaultPreflightReport>;
  return candidate.schemaVersion === CREATOR_VAULT_PREFLIGHT_SCHEMA_VERSION && (candidate.status === 'READY_FOR_NATIVE_GRANT' || candidate.status === 'BLOCKED' || candidate.status === 'ABORTED') && typeof candidate.ready === 'boolean' && Array.isArray(candidate.blockerCodes) && candidate.readOnly === true;
}
