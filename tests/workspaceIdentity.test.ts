/**
 * What the product calls itself, and when.
 *
 * HARD GATE C's sixth item is a labelling defect waiting to happen: "Read-only workspace" was a
 * literal in the shell, true while nothing could write and a lie the moment something could. These
 * cases pin the derivation instead — the identity follows a *resolved write path*, not a mode, so a
 * record-store run whose writes are still refused keeps saying read-only because that is still true.
 *
 * Gate 14's enrollment gate added the second half: the badge must make live data unmistakable from
 * fixture bytes, and the refusal a reader sees must be the one the gate actually returned. Both are
 * asserted here against the same call the shell makes, so a surface that started guessing would
 * fail rather than drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SURFACE_RECORD_TYPE,
  sourceLabelFor,
  workspaceIdentityFor,
  workspaceWritesFor,
  writeAdmissionSentenceFor,
  writeAdmissionViewFor,
} from '../src/browser/workspaceIdentity.js';

const MAIN_SOURCE = readFileSync(resolve(process.cwd(), 'src/browser/main.ts'), 'utf8');

describe('Stage 9 workspace identity', () => {
  it('names the source a reader is looking at, in all three modes', () => {
    expect(sourceLabelFor('fixture')).toBe('Fixture data · read-only');
    expect(sourceLabelFor('external')).toBe('Live data · read-only');
    // Both halves are named: records moved to the store, and the vault is still where notes,
    // drawings and attachments live.
    expect(sourceLabelFor('record-store')).toBe('Record store records · vault notes');
  });

  it('makes live data unmistakable from fixture bytes', () => {
    // The distinction is the point of the box rather than a wording preference: a reader offered a
    // mutation has to know whether the bytes behind it are theirs.
    expect(sourceLabelFor('external')).not.toBe(sourceLabelFor('fixture'));
    expect(sourceLabelFor('external')).toContain('Live');
    expect(sourceLabelFor('fixture')).toContain('Fixture');
    expect(sourceLabelFor('external')).not.toContain('Fixture');
    expect(sourceLabelFor('fixture')).not.toContain('Live');
  });

  it('stops claiming read-only exactly when a record write path resolved', () => {
    expect(workspaceIdentityFor('record-store', true)).toBe('Editable workspace');
    expect(workspaceIdentityFor('record-store', false)).toBe('Read-only workspace');
    // A fixture or an external vault has no record write path at all, so the claim stays true
    // however the flag is set: there is nothing to write records *to*.
    expect(workspaceIdentityFor('fixture', true)).toBe('Read-only workspace');
    expect(workspaceIdentityFor('external', true)).toBe('Read-only workspace');
    expect(workspaceIdentityFor('fixture', false)).toBe('Read-only workspace');
  });

  it('reports the same fact as a machine-readable value', () => {
    expect(workspaceWritesFor('record-store', true)).toBe('available');
    expect(workspaceWritesFor('record-store', false)).toBe('unavailable');
    expect(workspaceWritesFor('external', true)).toBe('unavailable');
  });

  it('refuses live data at the surface, with the gate\'s own reason', () => {
    const live = writeAdmissionViewFor('external', false);
    expect(live.machineValue).toBe('refused');
    expect(live.reason).toBe('native-transaction-required');
    expect(live.liveData).toBe(true);
    expect(live.sentence).toBe('Writes refused: live data is read-only');
  });

  it('keeps the ordinary modes running and names what they may write', () => {
    // The gate guards the creator's bytes; it must not become a wall in front of the product's own.
    const recordStore = writeAdmissionViewFor('record-store', true);
    expect(recordStore.machineValue).toBe('allowed');
    expect(recordStore.reason).toBe('none');
    expect(recordStore.sentence).toBe('Writes: record store only');
    expect(writeAdmissionViewFor('fixture', true).sentence).toBe('Writes: fixture bytes only');
    // A record-store run whose write path did not resolve is refused for the honest reason, and it
    // is not the live-data reason: these are different facts and the surface must not merge them.
    const unresolved = writeAdmissionViewFor('record-store', false);
    expect(unresolved.reason).toBe('writes-unavailable');
    expect(unresolved.liveData).toBe(false);
    expect(unresolved.sentence).toBe('Writes refused: no write path');
  });

  it('says something for every verdict, including the ones it cannot reach today', () => {
    for (const mode of ['fixture', 'external', 'record-store'] as const) {
      for (const writes of [true, false]) {
        const view = writeAdmissionViewFor(mode, writes);
        expect(view.sentence.length).toBeGreaterThan(0);
        expect(['allowed', 'refused']).toContain(view.machineValue);
        expect(view.admission.liveData).toBe(view.liveData);
        // The sentence is derived from the verdict rather than written beside it.
        expect(view.sentence).toBe(writeAdmissionSentenceFor(view.admission));
      }
    }
  });

  it('asks the gate about the record type whose write path the shell resolves', () => {
    expect(SURFACE_RECORD_TYPE).toBe('task');
    expect(writeAdmissionViewFor('record-store', true, 'event').admission).toMatchObject({ recordType: 'event' });
  });

  it('is consumed by the shell rather than restated in it', () => {
    expect(MAIN_SOURCE).toContain('workspaceIdentityFor(sourceMode, writesAvailable)');
    expect(MAIN_SOURCE).toContain('sourceLabelFor(sourceMode)');
    expect(MAIN_SOURCE).toContain('data-papers-visual-key="workspace-identity"');
    expect(MAIN_SOURCE).toContain('data-workspace-writes=');
    // The two new rendered facts: which source, and what the gate said about writing it.
    expect(MAIN_SOURCE).toContain('data-papers-visual-key="source-mode-badge"');
    expect(MAIN_SOURCE).toContain('data-proxima-live-data=');
    expect(MAIN_SOURCE).toContain('data-write-admission-reason=');
    // The literal is gone from the shell: the only place it may appear is the derivation itself.
    expect(MAIN_SOURCE).not.toContain('<span>Read-only workspace</span>');
  });
});
