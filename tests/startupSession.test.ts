import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createStartupSessionOrchestrator } from '../src/app/startupSession.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';
import type { ExternalDirectoryHandleLike } from '../src/adapters/externalDirectoryVault.js';
import type { OpfsHandleLike } from '../src/adapters/opfsVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

class FileHandle {
  readonly kind = 'file' as const;
  unreadable = false;
  reads = 0;
  constructor(public value: string, public readonly name: string) {}
  async getFile() { this.reads += 1; if (this.unreadable) throw new Error('permission lost'); return { text: async () => this.value, size: this.value.length, lastModified: 0 }; }
}

class DirectoryHandle implements ExternalDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly name = 'restored-session';
  readonly children = new Map<string, DirectoryHandle | FileHandle>();
  throws = false;
  async *entries(): AsyncIterableIterator<[string, OpfsHandleLike]> {
    if (this.throws) throw new Error('directory unavailable');
    for (const [name, child] of [...this.children.entries()].sort(([a], [b]) => a.localeCompare(b))) yield [name, child];
  }
}

function handleFromFiles(files: Record<string, string>): DirectoryHandle {
  const root = new DirectoryHandle();
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let current = root;
    for (const part of parts) {
      const existing = current.children.get(part);
      if (existing instanceof DirectoryHandle) current = existing;
      else { const next = new DirectoryHandle(); current.children.set(part, next); current = next; }
    }
    current.children.set(name, new FileHandle(value, name));
  }
  return root;
}

function schedulerHarness() {
  let next = 1;
  const timers = new Set<number>();
  return { scheduler: { setInterval: () => { const id = next++; timers.add(id); return id; }, clearInterval: (id: unknown) => { timers.delete(id as number); } }, timers };
}

async function fixtureCandidate() {
  const reader = fixtureVault('vault-basic');
  return { mode: 'fixture' as const, reader, initial: await loadVaultState(reader) };
}

describe('Gate 6I startup/session restoration semantics', () => {
  it('boots fixture once with no handle and does not duplicate policy on repeated start', async () => {
    const harness = schedulerHarness();
    const orchestrator = createStartupSessionOrchestrator({ fixture: await fixtureCandidate(), restored: { store: { restore: async () => null }, permissions: { queryPermission: async () => 'granted' } }, scheduler: harness.scheduler });
    const first = await orchestrator.start();
    const second = await orchestrator.start();
    expect(first.session).toBe(second.session);
    expect(first.inspection).toMatchObject({ startupSourceMode: 'fixture', restoredHandlePresent: false, bootstrapStatus: 'no-restored-handle', sessionState: 'stable' });
    expect(harness.timers.size).toBe(1);
    orchestrator.dispose();
    expect(harness.timers.size).toBe(0);
  });

  it('boots restored granted external state and a simulated restart restores the same logical data', async () => {
    const handle = handleFromFiles(fixtureFiles('vault-basic'));
    const fixture = await fixtureCandidate();
    const options = { fixture, restored: { store: { restore: async () => handle }, permissions: { queryPermission: async () => 'granted' as const } } };
    const first = await createStartupSessionOrchestrator(options).start();
    const second = await createStartupSessionOrchestrator(options).start();
    expect(first.inspection).toMatchObject({ startupSourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready', sessionState: 'stable' });
    expect(first.session.projection().state.tasks).toHaveLength(7);
    expect(second.session.projection().state.projects.map((project) => project.id)).toEqual(first.session.projection().state.projects.map((project) => project.id));
    first.session.dispose();
    second.session.dispose();
  });

  it('falls back deterministically for prompt, denied, query failure, and granted activation failure', async () => {
    const fixture = await fixtureCandidate();
    for (const permission of ['prompt', 'denied'] as const) {
      const handle = handleFromFiles(fixtureFiles('vault-basic'));
      const result = await createStartupSessionOrchestrator({ fixture, restored: { store: { restore: async () => handle }, permissions: { queryPermission: async () => permission } } }).start();
      expect(result.inspection).toMatchObject({ startupSourceMode: 'fixture', bootstrapStatus: permission === 'prompt' ? 'permission-required' : 'permission-denied' });
      expect([...handle.children.values()].some((child) => child instanceof FileHandle && child.reads > 0)).toBe(false);
      result.session.dispose();
    }
    const queryFailure = await createStartupSessionOrchestrator({ fixture, restored: { store: { restore: async () => handleFromFiles(fixtureFiles('vault-basic')) }, permissions: { queryPermission: async () => { throw new Error('query'); } } } }).start();
    expect(queryFailure.inspection.bootstrapStatus).toBe('permission-check-failed');
    queryFailure.session.dispose();
    const broken = handleFromFiles(fixtureFiles('vault-basic')); broken.throws = true;
    const activation = await createStartupSessionOrchestrator({ fixture, restored: { store: { restore: async () => broken }, permissions: { queryPermission: async () => 'granted' as const } } }).start();
    expect(activation.inspection).toMatchObject({ startupSourceMode: 'fixture', bootstrapStatus: 'ready', problemCodes: ['activation-failed'] });
    activation.session.dispose();
  });

  it('degrades after permission loss and recovers on a clean granted restart without stale prior state', async () => {
    const handle = handleFromFiles(fixtureFiles('vault-basic'));
    const fixture = await fixtureCandidate();
    const first = await createStartupSessionOrchestrator({ fixture, restored: { store: { restore: async () => handle }, permissions: { queryPermission: async () => 'granted' as const } } }).start();
    const standup = (handle.children.get('Proxima') as DirectoryHandle).children.get('tasks') as DirectoryHandle;
    const standupFile = standup.children.get('Daily standup.md') as FileHandle;
    standupFile.unreadable = true;
    const failed = await first.session.refresh('manual');
    expect(failed?.ok).toBe(false);
    expect(first.session.projection().health.stale).toBe(true);
    first.session.dispose();
    standupFile.unreadable = false;
    const second = await createStartupSessionOrchestrator({ fixture, restored: { store: { restore: async () => handle }, permissions: { queryPermission: async () => 'granted' as const } } }).start();
    expect(second.inspection).toMatchObject({ startupSourceMode: 'external', bootstrapStatus: 'ready', sessionState: 'stable' });
    expect(second.session.projection().health.stale).toBe(false);
    second.session.dispose();
  });
});
