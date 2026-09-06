import type { FsaProbeEntry, FsaProbeReport } from './fsaProbe.js';

const MAX_ENTRIES = 200;
const MAX_TEXT = 400;
const MAX_HANDLE_NAME = 128;
const MAX_REVISION = 200;

export interface FsaEvidenceValidation {
  ok: boolean;
  errors: string[];
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
