import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createVaultMutationCoordinator } from '../src/app/vaultMutation.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { updateEventOptional } from '../src/app/eventOptionalMutation.js';

function readerFor(vault: ReturnType<typeof createMemoryVault>) { return { ...vault, readBinary: async (path: string, maxBytes: number) => { const file = await vault.read(path); const bytes = new TextEncoder().encode(file.text); if (bytes.byteLength > maxBytes) throw new Error('large'); return { ...file, bytes }; } }; }
function event(revision: string, path = 'Proxima/events/e1.md') { return { id: 'e1', source: { path, revision, kind: 'event' as const, idOrigin: 'frontmatter' as const } }; }
const source = '---\nid: e1\nname: Event\nproject: old\nstartDate: 2026-09-01\ndeadline: 2026-09-02\nisCompleted: false\nforeign: &x value\n---\nbody';

describe('13.2L explicit event optional mutation', () => {
  it('sets and unlinks project, clears start, and uses start as deadline', async () => {
    const vault = createMemoryVault({ 'Proxima/events/e1.md': source }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); let observed = await reader.read('Proxima/events/e1.md');
    const run = async (mutation: Parameters<typeof updateEventOptional>[0]['mutation']) => { observed = await reader.read(observed.path); return updateEventOptional({ event: event(observed.revision), path: observed.path, reader, coordinator, mutation }); };
    expect(await run({ kind: 'set-project', value: 'next' })).toMatchObject({ ok: true }); expect(await run({ kind: 'unlink-project' })).toMatchObject({ ok: true }); expect(await run({ kind: 'clear-start' })).toMatchObject({ ok: true }); expect(await run({ kind: 'use-start-as-deadline' })).toMatchObject({ ok: true });
    const loaded = (await loadVaultState(reader)).state.events.find((e) => e.id === 'e1'); expect(loaded).toMatchObject({ projectId: null, startDate: '', deadline: '', source: { path: 'Proxima/events/e1.md' } }); expect((await reader.read(observed.path)).text).toContain('foreign: &x value\n');
  });

  it('inserts missing project/start/deadline and preserves fallback semantics', async () => {
    const vault = createMemoryVault({ 'Proxima/events/e1.md': '---\nid: e1\nname: Event\n---\nbody' }); const reader = readerFor(vault); const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); let observed = await reader.read('Proxima/events/e1.md');
    const run = async (mutation: Parameters<typeof updateEventOptional>[0]['mutation']) => { observed = await reader.read(observed.path); return updateEventOptional({ event: event(observed.revision), path: observed.path, reader, coordinator, mutation }); };
    expect(await run({ kind: 'set-project', value: 'p' })).toMatchObject({ ok: true }); expect(await run({ kind: 'set-start', value: '2026-10-01' })).toMatchObject({ ok: true }); expect(await run({ kind: 'set-deadline', value: '2026-10-03' })).toMatchObject({ ok: true }); expect(await run({ kind: 'use-start-as-deadline' })).toMatchObject({ ok: true });
    const loaded = (await loadVaultState(reader)).state.events.find((e) => e.id === 'e1'); expect(loaded).toMatchObject({ projectId: 'p', startDate: '2026-10-01', deadline: '2026-10-01' });
  });

  it('refuses unknown/invalid/out-of-scope operations before reads and handles missing clears as no-ops', async () => {
    const vault = createMemoryVault({ 'Proxima/events/e1.md': source }); let reads = 0; const base = readerFor(vault); const reader = { ...base, readBinary: async (path: string, maxBytes: number) => { reads += 1; return base.readBinary(path, maxBytes); } }; const coordinator = createVaultMutationCoordinator({ reader, writer: vault }); const rev = (await reader.read('Proxima/events/e1.md')).revision; const common = { event: event(rev), path: 'Proxima/events/e1.md', reader, coordinator };
    expect(await updateEventOptional({ ...common, mutation: { kind: 'bogus' as never } })).toMatchObject({ ok: false, reason: 'field-not-allowed' }); expect(await updateEventOptional({ ...common, mutation: { kind: 'set-start', value: '' } })).toMatchObject({ ok: false, reason: 'invalid-value' }); expect(await updateEventOptional({ ...common, event: event(rev, 'Proxima/tasks/e1.md'), mutation: { kind: 'clear-start' } })).toMatchObject({ ok: false, reason: 'invalid-provenance' }); expect(reads).toBe(0);
    const noDeadline = createMemoryVault({ 'Proxima/events/e1.md': '---\nid: e1\nname: Event\n---\nbody' }); const noReader = readerFor(noDeadline); const noCoordinator = createVaultMutationCoordinator({ reader: noReader, writer: noDeadline }); const noRev = (await noReader.read('Proxima/events/e1.md')).revision; expect(await updateEventOptional({ event: event(noRev), path: 'Proxima/events/e1.md', reader: noReader, coordinator: noCoordinator, mutation: { kind: 'use-start-as-deadline' } })).toMatchObject({ ok: true, noOp: true });
  });
});
