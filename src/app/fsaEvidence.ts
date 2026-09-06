import type { FsaProbeEntry, FsaProbeReport } from './fsaProbe.js';

const MAX_ENTRIES = 200;
const MAX_TEXT = 400;
const MAX_HANDLE_NAME = 128;
const MAX_REVISION = 200;

export const CLEAN_PROFILE_EXPECTED_HANDLE = 'gate5-fsa-clean-fixture';
export const CLEAN_PROFILE_EXPECTED_MARKER = 'clean-profile-root-v1';
export const CLEAN_PROFILE_EXPECTED_ENTRIES = [
  { path: 'nested', kind: 'directory' },
  { path: 'nested/child-note.txt', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'root-note.txt', kind: 'file' },
] as const;

export interface FsaEvidenceValidation {
  ok: boolean;
  errors: string[];
}

export interface CleanProfileBuildIdentity {
  proximaVersion: string;
  gitSha: string;
  buildMode: string;
  fixtureHash: string;
}

export type CleanProfileFailureCode =
  | 'invalid-report'
  | 'report-error'
  | 'wrong-handle'
  | 'missing-entry'
  | 'unexpected-entry'
  | 'wrong-entry-kind'
  | 'missing-marker'
  | 'permission-not-granted'
  | 'persistence-not-proven';

export interface CleanProfileAcceptance {
  schemaVersion: 1;
  scenarioId: 'gate5-clean-profile';
  build: CleanProfileBuildIdentity;
  passed: boolean;
  validation: { passed: boolean; failureCodes: CleanProfileFailureCode[]; details: string[] };
  observed: { handleName: string | null; permission: string | null; persisted: boolean | null; entryPaths: string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function looksAbsolute(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file://');
}

/** FSA evidence paths are slash-separated paths relative to the granted handle. */
export function isRelativeFsaPath(value: string): boolean {
  if (!value || value.length > MAX_TEXT || looksAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function hasAbsoluteString(value: unknown): boolean {
  if (typeof value === 'string') return looksAbsolute(value) || /^[A-Za-z]:\\/.test(value);
  if (Array.isArray(value)) return value.some(hasAbsoluteString);
  if (isRecord(value)) return Object.values(value).some(hasAbsoluteString);
  return false;
}

function validateEntry(value: unknown, index: number, errors: string[]): value is FsaProbeEntry {
  if (!isRecord(value) || (value.kind !== 'file' && value.kind !== 'directory') || typeof value.path !== 'string' || !isRelativeFsaPath(value.path)) {
    errors.push(`entries[${index}] must have a relative path and a valid kind`);
    return false;
  }
  if (value.kind === 'file') {
    if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) errors.push(`entries[${index}].size must be a non-negative integer`);
    if (typeof value.textMarker !== 'string' || value.textMarker.length > MAX_TEXT) errors.push(`entries[${index}].textMarker must be bounded text`);
    if (typeof value.revision !== 'string' || value.revision.length > MAX_REVISION) errors.push(`entries[${index}].revision must be bounded text`);
  }
  return true;
}

/** Validate the bounded, relative-only report emitted by the real FSA probe. */
export function validateFsaEvidence(value: unknown): FsaEvidenceValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['report must be an object'] };
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof value.handleName !== 'string' || value.handleName.length === 0 || value.handleName.length > MAX_HANDLE_NAME) errors.push('handleName must be bounded text');
  if (!['granted', 'denied', 'prompt', 'unknown'].includes(String(value.permission))) errors.push('permission must be a File System Access permission state');
  if (typeof value.persisted !== 'boolean') errors.push('persisted must be boolean');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) errors.push('entries must be a bounded array');
  if (Array.isArray(value.entries)) {
    const paths = new Set<string>();
    value.entries.forEach((entry, index) => {
      if (validateEntry(entry, index, errors)) {
        if (paths.has(entry.path)) errors.push(`entries[${index}].path is duplicated`);
        paths.add(entry.path);
      }
    });
  }
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > MAX_TEXT)) errors.push('error must be bounded text');
  if (hasAbsoluteString(value)) errors.push('report must not contain absolute paths');
  return { ok: errors.length === 0, errors };
}

export function isFsaEvidence(value: unknown): value is FsaProbeReport {
  return validateFsaEvidence(value).ok;
}

function boundedIdentity(identity: CleanProfileBuildIdentity): CleanProfileBuildIdentity {
  return {
    proximaVersion: identity.proximaVersion.slice(0, MAX_TEXT),
    gitSha: identity.gitSha.slice(0, MAX_TEXT),
    buildMode: identity.buildMode.slice(0, MAX_TEXT),
    fixtureHash: identity.fixtureHash.slice(0, MAX_TEXT),
  };
}

/** Evaluate a captured clean-profile report without invoking browser or filesystem APIs. */
export function evaluateCleanProfileAcceptance(report: unknown, build: CleanProfileBuildIdentity): CleanProfileAcceptance {
  const validation = validateFsaEvidence(report);
  const failureCodes: CleanProfileFailureCode[] = [];
  const details = validation.errors.slice(0, 20);
  const candidate = isRecord(report) ? report : {};
  const entries = Array.isArray(candidate.entries) ? candidate.entries.filter(isRecord) : [];
  const observedPaths = entries.filter((entry): entry is Record<string, unknown> => typeof entry.path === 'string' && isRelativeFsaPath(entry.path as string)).map((entry) => entry.path as string).sort();
  const handleName = typeof candidate.handleName === 'string' && !looksAbsolute(candidate.handleName) ? candidate.handleName.slice(0, MAX_HANDLE_NAME) : null;
  const permission = typeof candidate.permission === 'string' ? candidate.permission : null;
  const persisted = typeof candidate.persisted === 'boolean' ? candidate.persisted : null;

  if (!validation.ok) failureCodes.push('invalid-report');
  if (typeof candidate.error === 'string' && candidate.error.length > 0) failureCodes.push('report-error');
  if (handleName !== CLEAN_PROFILE_EXPECTED_HANDLE) failureCodes.push('wrong-handle');
  const expected = new Map<string, 'file' | 'directory'>(CLEAN_PROFILE_EXPECTED_ENTRIES.map((entry) => [entry.path, entry.kind]));
  const observed = new Map<string, string>();
  for (const entry of entries) if (typeof entry.path === 'string' && typeof entry.kind === 'string') observed.set(entry.path, entry.kind);
  for (const [path, kind] of expected) {
    if (!observed.has(path)) failureCodes.push('missing-entry');
    else if (observed.get(path) !== kind) failureCodes.push('wrong-entry-kind');
  }
  if ([...observed.keys()].some((path) => !expected.has(path))) failureCodes.push('unexpected-entry');
  const root = entries.find((entry) => entry.path === 'root-note.txt');
  if (typeof root?.textMarker !== 'string' || !root.textMarker.includes(CLEAN_PROFILE_EXPECTED_MARKER)) failureCodes.push('missing-marker');
  if (permission !== 'granted') failureCodes.push('permission-not-granted');
  if (persisted !== true) failureCodes.push('persistence-not-proven');

  const uniqueCodes = [...new Set(failureCodes)];
  return {
    schemaVersion: 1,
    scenarioId: 'gate5-clean-profile',
    build: boundedIdentity(build),
    passed: uniqueCodes.length === 0,
    validation: { passed: uniqueCodes.length === 0, failureCodes: uniqueCodes, details },
    observed: { handleName, permission, persisted, entryPaths: observedPaths.slice(0, MAX_ENTRIES) },
  };
}
