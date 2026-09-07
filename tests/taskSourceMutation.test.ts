import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { createMemoryRecoveryStore } from '../src/app/vaultRecovery.js';
import { planTaskStatusPatch } from '../src/app/sourcePreservingMarkdown.js';
import { updateTaskStatus } from '../src/app/taskSourceMutation.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('13.2A source-preserving task status mutation', () => {
  it('changes only the existing scalar and preserves lossy/foreign bytes, BOM and CRLF', async () => {
    const original = '\uFEFF---\r\nstatus: "running" # creator comment\r\nforeign: &x value\r\nalias: *x\r\nmeta:\r\n  owner: someone\r\ndescription: |\r\n  keep\r\n  exactly\r\n---\r\nbody status: fake\r\n';
    const vault = createMemoryVault({ 'tasks/a.md': original });
    const reader = { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = enc.encode(original); if (bytes.byteLength > maxBytes) throw new Error('too large'); return { ...file, bytes }; } };
    const observed = await reader.read('tasks/a.md');
    const recovery = createMemoryRecoveryStore({ now: () => Date.parse('2026-09-08T00:00:00Z') });
    let committed: Uint8Array | undefined;
    const writer = { ...vault, writeIfUnchanged: async (path: string, bytes: Uint8Array, revision: string) => { committed = new Uint8Array(bytes); return vault.writeIfUnchanged(path, bytes, revision); } };
    const coordinator = createVaultMutationCoordinator({ reader, writer, recovery });
    const result = await updateTaskStatus({ path: 'tasks/a.md', expectedRevision: observed.revision, status: 'finished', reader, coordinator });
    expect(result).toMatchObject({ ok: true });
    const changed = committed as Uint8Array;
    const actual = new TextDecoder('utf-8', { ignoreBOM: true }).decode(changed);
    expect(actual).toContain('\uFEFF---\r\nstatus: "finished" # creator comment\r\nforeign: &x value\r\nalias: *x\r\nmeta:\r\n  owner: someone\r\ndescription: |\r\n  keep\r\n  exactly\r\n---\r\nbody status: fake\r\n');
    expect(recovery.list()[0]?.status).toBe('committed');
    const patch = planTaskStatusPatch(enc.encode(original), 'finished');
    expect(patch.ok).toBe(true);
    if (patch.ok) {
      const before = enc.encode(original); const after = patch.bytes;
      expect(dec.decode(before.slice(0, patch.start))).toBe(dec.decode(after.slice(0, patch.start)));
      expect(dec.decode(before.slice(patch.end))).toBe(dec.decode(after.slice(patch.start + enc.encode('"finished"').byteLength)));
    }
  });

  it('preserves plain and single-quoted representation, whitespace, comments and line endings', () => {
    const plain = '---\nstatus:   running   # keep\nname: task\n---\nbody';
    const planned = planTaskStatusPatch(enc.encode(plain), 'finished');
    expect(planned).toMatchObject({ ok: true });
    if (planned.ok) expect(dec.decode(planned.bytes)).toBe('---\nstatus:   finished   # keep\nname: task\n---\nbody');
    const single = planTaskStatusPatch("---\r\nstatus: 'run''ning' # keep\r\n---\r\nbody", "done'soon");
    expect(single).toMatchObject({ ok: true });
    if (single.ok) expect(dec.decode(single.bytes)).toBe("---\r\nstatus: 'done''soon' # keep\r\n---\r\nbody");
  });

  it('fails closed for absent, duplicate, nested, structured, malformed and unsafe targets', () => {
    expect(planTaskStatusPatch('body', 'finished')).toMatchObject({ ok: false, reason: 'no-frontmatter' });
    expect(planTaskStatusPatch('---\nname: task\n---\nbody', 'finished')).toMatchObject({ ok: false, reason: 'target-missing' });
    expect(planTaskStatusPatch('---\nstatus: running\nstatus: finished\n---', 'done')).toMatchObject({ ok: false, reason: 'target-ambiguous' });
    expect(planTaskStatusPatch('---\nmeta:\n  status: running\n---', 'done')).toMatchObject({ ok: false, reason: 'target-missing' });
    expect(planTaskStatusPatch('---\nstatus:\n  - running\n---', 'done')).toMatchObject({ ok: false, reason: 'target-unsupported' });
    expect(planTaskStatusPatch('---\nstatus: "running\n---', 'done')).toMatchObject({ ok: false, reason: 'target-unsupported' });
    expect(planTaskStatusPatch('---\nstatus: running\n---', 'not safe')).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(planTaskStatusPatch(new Uint8Array([0xff, 0xfe]), 'done')).toMatchObject({ ok: false, reason: 'invalid-utf8' });
  });

  it('uses the observed revision for the final conditional commit and leaves stale source exact', async () => {
    const original = '---\nstatus: running\nforeign: keep\n---\nbody';
    const vault = createMemoryVault({ 'tasks/a.md': original });
    const reader = { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = enc.encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('too large'); return { ...file, bytes }; } };
    const observed = await reader.read('tasks/a.md');
    const recovery = createMemoryRecoveryStore({ now: () => 0 });
    const coordinator = createVaultMutationCoordinator({ reader, writer: vault, recovery });
    vault.set('tasks/a.md', '---\nstatus: peer\nforeign: keep\n---\nbody');
    const result = await updateTaskStatus({ path: 'tasks/a.md', expectedRevision: observed.revision, status: 'finished', reader, coordinator });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect((await vault.read('tasks/a.md')).text).toContain('status: peer');
    expect(recovery.list()[0]?.status).toBe('recovered');
  });
});
