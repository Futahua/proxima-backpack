import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createSourceSession, type SourceCandidate } from '../src/app/sourceSession.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

function schedulerHarness() {
  let nextHandle = 1;
  const timers = new Set<number>();
  return {
    scheduler: { setInterval: () => { const handle = nextHandle++; timers.add(handle); return handle; }, clearInterval: (handle: unknown) => { timers.delete(handle as number); } },
    timers,
  };
}

async function candidate(mode: SourceCandidate['mode'], reader: SourceCandidate['reader']): Promise<SourceCandidate> {
  return { mode, reader, initial: await loadVaultState(reader) };
}

describe('Gate 6H source-mode transition state machine', () => {
  it('switches fixture to external and back with one active policy and generation tags', async () => {
    const fixture = fixtureVault('vault-basic');
    const external = createMemoryVault(fixtureFiles('vault-basic'));
    const harness = schedulerHarness();
    const session = createSourceSession({ initial: await candidate('fixture', fixture), scheduler: harness.scheduler, intervalMs: 2_000 });
    expect(session.snapshot()).toMatchObject({ sourceMode: 'fixture', sourceGeneration: 1, transitionState: 'stable' });
    const externalResult = await session.switchTo(await candidate('external', external));
    expect(externalResult).toMatchObject({ ok: true, sourceMode: 'external', snapshot: { sourceGeneration: 2, transitionState: 'stable' } });
    expect(harness.timers.size).toBe(1);
    external.set('Proxima/projects/Term Calendar.md', '---\nid: proj-term\nname: External source\nprojectType: schedule\nstatus: active\ncreatedAt: 2026-08-20T08:00:00.000Z\n---\n');
    await session.refresh('manual');
    expect(session.projection().state.projects.find((project) => project.id === 'proj-term')?.name).toBe('External source');
    expect(session.snapshot().sourceGeneration).toBe(3);
    const fixtureResult = await session.switchTo(await candidate('fixture', fixture));
    expect(fixtureResult).toMatchObject({ ok: true, sourceMode: 'fixture', snapshot: { sourceGeneration: 4, transitionState: 'stable' } });
    expect(harness.timers.size).toBe(1);
  });

  it('keeps the previous stable source on a failed activation and never exposes candidate authority', async () => {
    const fixture = fixtureVault('vault-basic');
    const session = createSourceSession({ initial: await candidate('fixture', fixture), scheduler: schedulerHarness().scheduler });
    const failed = await session.switchTo({ mode: 'external', reader: null as never, initial: null as never });
    expect(failed).toMatchObject({ ok: false, sourceMode: 'fixture', snapshot: { sourceMode: 'fixture', transitionState: 'failed' } });
    expect(session.projection().state.projects).toHaveLength(3);
    expect(JSON.stringify(session.snapshot())).not.toContain('reader');
  });

  it('ignores a late old-source refresh completion after a switch', async () => {
    const base = fixtureVault('vault-basic');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = { ...base, read: async (path: string) => { await gate; return base.read(path); } };
    const external = createMemoryVault(fixtureFiles('vault-basic'));
    external.set('Proxima/projects/Term Calendar.md', '---\nid: proj-term\nname: External winner\nprojectType: schedule\nstatus: active\ncreatedAt: 2026-08-20T08:00:00.000Z\n---\n');
    const session = createSourceSession({ initial: { mode: 'fixture', reader: delayed, initial: await loadVaultState(base) }, scheduler: schedulerHarness().scheduler });
    const oldRefresh = session.refresh('manual');
    const switched = session.switchTo(await candidate('external', external));
    release();
    await oldRefresh;
    const result = await switched;
    expect(result.snapshot.sourceMode).toBe('external');
    expect(session.projection().state.projects.find((project) => project.id === 'proj-term')?.name).toBe('External winner');
    expect(session.snapshot().transitionState).toBe('stable');
  });
});
