/**
 * The write gate's own cases.
 *
 * These are the evidence for Gate 14's "agent writes to real vault remain disabled by default" box,
 * and the box is only worth ticking if the gate can *fail*: a case that could not go red is a
 * comment with a type. So the same request shape is walked from closed to open one condition at a
 * time, and each step asserts the *named* reason it stopped at.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WRITE_ENROLLMENT,
  admitWrite,
  isLiveSource,
  type WriteAdmissionRequest,
  type WriteEnrollment,
} from '../src/app/writeAdmission.js';

const MAIN_SOURCE = readFileSync(resolve(process.cwd(), 'src/browser/main.ts'), 'utf8');
const IDENTITY_SOURCE = readFileSync(resolve(process.cwd(), 'src/browser/workspaceIdentity.ts'), 'utf8');

/** The most permissive enrollment anyone could write: every record type this product has. */
const ENROLLED_EVERYTHING: WriteEnrollment = { enrolled: true, recordTypes: ['task', 'event', 'project'] };

function request(overrides: Partial<WriteAdmissionRequest> = {}): WriteAdmissionRequest {
  return {
    sourceMode: 'fixture',
    recordType: 'task',
    writePathAvailable: true,
    enrollment: DEFAULT_WRITE_ENROLLMENT,
    nativeTransactionAvailable: false,
    ...overrides,
  };
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('the write gate', () => {
  it('ships a default that enrolls nothing', () => {
    expect(DEFAULT_WRITE_ENROLLMENT.enrolled).toBe(false);
    expect(DEFAULT_WRITE_ENROLLMENT.recordTypes).toEqual([]);
  });

  it('refuses live data even when every record type has been enrolled', () => {
    // The box, stated as a case: enrollment is deliberately *not* enough. The host has no atomic
    // commit, so the strongest permission a creator could give still does not open this path.
    const verdict = admitWrite(request({ sourceMode: 'external', enrollment: ENROLLED_EVERYTHING }));
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('native-transaction-required');
    expect(verdict.liveData).toBe(true);
  });

  it('names the first thing standing in the way, in capability-permission-scope order', () => {
    // Closed: no commit primitive, whatever the creator decides.
    expect(admitWrite(request({ sourceMode: 'external' }))).toMatchObject({
      allowed: false,
      reason: 'native-transaction-required',
    });
    // The capability is granted, the permission is not: the next reason, not the first one again.
    expect(admitWrite(request({ sourceMode: 'external', nativeTransactionAvailable: true }))).toMatchObject({
      allowed: false,
      reason: 'writes-disabled-by-default',
    });
    // Permission is granted for other record types, not this one.
    expect(admitWrite(request({
      sourceMode: 'external',
      nativeTransactionAvailable: true,
      enrollment: { enrolled: true, recordTypes: ['event'] },
    }))).toMatchObject({ allowed: false, reason: 'record-type-not-enrolled' });
  });

  it('opens a live write only when all three conditions hold together', () => {
    const verdict = admitWrite(request({
      sourceMode: 'external',
      nativeTransactionAvailable: true,
      enrollment: ENROLLED_EVERYTHING,
    }));
    expect(verdict).toMatchObject({ allowed: true, sourceMode: 'external', recordType: 'task', liveData: true });
  });

  it('does not protect bytes nobody else owns', () => {
    // Fixture bytes and the product's own record store are what ordinary runs read; the gate guards
    // the creator's data, and inventing a protection for disposable bytes would only make the
    // surface's claims harder to keep true.
    expect(admitWrite(request({ sourceMode: 'fixture' }))).toMatchObject({ allowed: true, liveData: false });
    expect(admitWrite(request({ sourceMode: 'record-store' }))).toMatchObject({ allowed: true, liveData: false });
  });

  it('still refuses when no write path resolved, and says so in the live case first', () => {
    expect(admitWrite(request({ sourceMode: 'record-store', writePathAvailable: false }))).toMatchObject({
      allowed: false,
      reason: 'writes-unavailable',
    });
    // A live source with nothing resolved is refused for the live reason: the ordering is the
    // contract, so the surface never reports a missing write path for data it must not write.
    expect(admitWrite(request({ sourceMode: 'external', writePathAvailable: false }))).toMatchObject({
      allowed: false,
      reason: 'native-transaction-required',
    });
  });

  it('classifies exactly one mode as live data', () => {
    expect(isLiveSource('external')).toBe(true);
    expect(isLiveSource('fixture')).toBe(false);
    expect(isLiveSource('record-store')).toBe(false);
  });

  it('is not enrollable from inside this repository', () => {
    // The scan is the assertion: a future slice that flips the default to make a test pass has to
    // delete this case, and that is a visible act rather than a quiet one-line change.
    const offenders = sourceFiles(resolve(process.cwd(), 'src'))
      .filter((path) => readFileSync(path, 'utf8').includes('enrolled: true'));
    expect(offenders).toEqual([]);
  });

  it('is consulted by the shell rather than described by it', () => {
    expect(MAIN_SOURCE).toContain('writeAdmissionViewFor(sourceMode');
    expect(MAIN_SOURCE).toContain('data-papers-visual-key="write-admission"');
    expect(MAIN_SOURCE).toContain('data-write-admission-reason=');
    // The host boundary report is *read* here; before this slice it had no runtime caller at all.
    expect(IDENTITY_SOURCE).toContain('evaluateFsaWriteBoundary()');
  });
});
