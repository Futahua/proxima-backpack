/**
 * Build provenance must describe the bytes that were built.
 *
 * `git rev-parse HEAD` answers "what was the last commit", not "what did you build".
 * Building from a modified working tree stamped a clean commit hash onto bytes that
 * commit does not contain — and the audit protocol quotes exactly that hash as the
 * unit of evidence, so the identity could confidently name the wrong code.
 *
 * These run the real tool against throwaway repositories under the OS temp
 * directory. Nothing here touches this repository's working tree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const tool = fileURLToPath(new URL('../tools/gitState.mjs', import.meta.url));
const temporaries: string[] = [];

interface GitState {
  sha: string;
  treeState: 'clean' | 'dirty' | 'unknown';
  dirtyFileCount: number;
  describe: string;
}

function readState(dir: string): GitState {
  return JSON.parse(execFileSync('node', [tool, dir]).toString()) as GitState;
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proxima-gitstate-'));
  temporaries.push(dir);
  return dir;
}

function repoWithOneCommit(): string {
  const dir = scratchDir();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(dir, 'committed.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe('git provenance for the build identity', () => {
  it('reports a clean tree with its exact commit', () => {
    const state = readState(repoWithOneCommit());
    expect(state.treeState).toBe('clean');
    expect(state.dirtyFileCount).toBe(0);
    expect(state.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.describe).toBe(state.sha);
  });

  it('reports a modified tracked file as dirty, keeping the exact commit', () => {
    const dir = repoWithOneCommit();
    const clean = readState(dir);
    writeFileSync(join(dir, 'committed.txt'), 'changed\n');
    const dirty = readState(dir);

    expect(dirty.sha).toBe(clean.sha);
    expect(dirty.treeState).toBe('dirty');
    expect(dirty.dirtyFileCount).toBe(1);
    expect(dirty.describe).toBe(`${clean.sha}-dirty`);
  });

  // fixtures/ is bundled into the page wholesale, so an uncommitted fixture file
  // genuinely changes what was built even though git never tracked it.
  it('counts an untracked file as dirty', () => {
    const dir = repoWithOneCommit();
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'never-committed.md'), '---\nid: ghost\n---\n');

    const state = readState(dir);
    expect(state.treeState).toBe('dirty');
    expect(state.dirtyFileCount).toBe(1);
    expect(state.describe).toMatch(/-dirty$/);
  });

  it('says unknown rather than failing when there is no repository', () => {
    const state = readState(scratchDir());
    expect(state).toMatchObject({
      sha: 'unknown',
      treeState: 'unknown',
      dirtyFileCount: 0,
      describe: 'unknown',
    });
  });

  it('never claims a clean describe for a dirty tree', () => {
    const dir = repoWithOneCommit();
    writeFileSync(join(dir, 'committed.txt'), 'changed\n');
    const state = readState(dir);
    expect(state.describe).not.toBe(state.sha);
    expect(state.describe.endsWith('-dirty')).toBe(true);
  });
});

describe('the generated build identity', () => {
  it('carries the provenance fields the audit protocol quotes', async () => {
    const identity = (
      await import('../src/browser/generated/buildIdentity.generated.js')
    ).BUILD_IDENTITY as Record<string, unknown>;

    for (const field of [
      'proximaVersion',
      'gitSha',
      'gitTreeState',
      'gitDirtyFileCount',
      'gitDescribe',
      'buildMode',
      'domainSchemaVersion',
      'controlSchemaVersion',
      'fixtureSchemaVersion',
      'fixtureHash',
      'lockfileHash',
      'fixedClock',
    ]) {
      expect(identity).toHaveProperty(field);
    }

    expect(['clean', 'dirty', 'unknown']).toContain(identity.gitTreeState);
    if (identity.gitTreeState === 'clean') expect(identity.gitDescribe).toBe(identity.gitSha);
    if (identity.gitTreeState === 'dirty') expect(identity.gitDescribe).toBe(`${identity.gitSha}-dirty`);
  });
});
