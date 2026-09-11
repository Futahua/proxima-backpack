/**
 * What the product calls itself, and when.
 *
 * HARD GATE C's sixth item is a labelling defect waiting to happen: "Read-only workspace" was a
 * literal in the shell, true while nothing could write and a lie the moment something could. These
 * cases pin the derivation instead — the identity follows a *resolved write path*, not a mode, so a
 * record-store run whose writes are still refused keeps saying read-only because that is still true.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceLabelFor, workspaceIdentityFor, workspaceWritesFor } from '../src/browser/workspaceIdentity.js';

const MAIN_SOURCE = readFileSync(resolve(process.cwd(), 'src/browser/main.ts'), 'utf8');

describe('Stage 9 workspace identity', () => {
  it('names the source a reader is looking at, in all three modes', () => {
    expect(sourceLabelFor('fixture')).toBe('Read-only fixture');
    expect(sourceLabelFor('external')).toBe('Read-only external source');
    // Both halves are named: records moved to the store, and the vault is still where notes,
    // drawings and attachments live.
    expect(sourceLabelFor('record-store')).toBe('Record store records · vault notes');
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

  it('is consumed by the shell rather than restated in it', () => {
    expect(MAIN_SOURCE).toContain('workspaceIdentityFor(sourceMode, writesAvailable)');
    expect(MAIN_SOURCE).toContain('sourceLabelFor(sourceMode)');
    expect(MAIN_SOURCE).toContain('data-c1-key="workspace-identity"');
    expect(MAIN_SOURCE).toContain('data-workspace-writes=');
    // The literal is gone from the shell: the only place it may appear is the derivation itself.
    expect(MAIN_SOURCE).not.toContain('<span>Read-only workspace</span>');
  });
});
