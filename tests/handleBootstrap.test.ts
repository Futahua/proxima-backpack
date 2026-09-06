import { describe, expect, it } from 'vitest';
import { bootstrapRestoredHandle, type ReadPermissionProvider, type RestoredHandleStore } from '../src/app/handleBootstrap.js';
import type { ExternalDirectoryHandleLike } from '../src/adapters/externalDirectoryVault.js';
import type { OpfsHandleLike } from '../src/adapters/opfsVault.js';
import { createBrowserSourceFromRestored } from '../src/browser/sourceFactory.js';

class EmptyDirectory implements ExternalDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly name = 'restored-fixture';
  async *entries(): AsyncIterableIterator<[string, OpfsHandleLike]> { /* empty restored fixture */ }
}

function store(value: ExternalDirectoryHandleLike | null): RestoredHandleStore { return { restore: async () => value }; }

function permissions(value: 'granted' | 'prompt' | 'denied'): ReadPermissionProvider & { calls: { mode: 'read' }[] } {
  const calls: { mode: 'read' }[] = [];
  return { calls, queryPermission: async (options) => { calls.push(options); return value; } };
}

describe('Gate 6G persisted-handle bootstrap', () => {
  it('falls back cleanly when no handle is restored and does not query permission', async () => {
    let queried = false;
    const result = await bootstrapRestoredHandle(store(null), { queryPermission: async () => { queried = true; return 'granted'; } });
    expect(result.reader).toBeNull();
    expect(result.inspection).toMatchObject({ sourceMode: 'fixture', restoredHandlePresent: false, permission: null, bootstrapStatus: 'no-restored-handle' });
    expect(queried).toBe(false);
  });

  it('queries read permission exactly once and constructs the same external reader only when granted', async () => {
    const provider = permissions('granted');
    const result = await bootstrapRestoredHandle(store(new EmptyDirectory()), provider);
    expect(provider.calls).toEqual([{ mode: 'read' }]);
    expect(result.reader).not.toBeNull();
    expect(await result.reader!.list('')).toEqual([]);
    expect(result.inspection).toMatchObject({ sourceMode: 'restored', restoredHandlePresent: true, handleKind: 'directory', handleName: 'restored-fixture', permission: 'granted', bootstrapStatus: 'ready', problemCodes: [] });
    expect('requestPermission' in result).toBe(false);
    expect(JSON.stringify(result.inspection)).not.toContain('entries');
    const source = await createBrowserSourceFromRestored(store(new EmptyDirectory()), provider);
    expect(source.mode).toBe('injected');
    expect(source.bootstrap.bootstrapStatus).toBe('ready');
  });

  it('uses the fixture source when a restored handle is still waiting for permission', async () => {
    const source = await createBrowserSourceFromRestored(store(new EmptyDirectory()), permissions('prompt'));
    expect(source.mode).toBe('fixture');
    expect(source.bootstrap).toMatchObject({ sourceMode: 'fixture', bootstrapStatus: 'permission-required', permission: 'prompt' });
    expect(await source.reader.walk('Proxima/tasks')).toContain('Proxima/tasks/Daily standup.md');
  });

  it('keeps prompt and denied states explicit without reading or requesting permission', async () => {
    for (const value of ['prompt', 'denied'] as const) {
      const provider = permissions(value);
      const result = await bootstrapRestoredHandle(store(new EmptyDirectory()), provider);
      expect(result.reader).toBeNull();
      expect(result.inspection).toMatchObject({ restoredHandlePresent: true, permission: value, bootstrapStatus: value === 'prompt' ? 'permission-required' : 'permission-denied', sourceMode: 'fixture' });
    }
  });

  it('reports bounded failures for restore/query/structure errors and sanitizes unsafe names', async () => {
    const restoreFailed = await bootstrapRestoredHandle({ restore: async () => { throw new Error('secret absolute C:/vault'); } }, permissions('granted'));
    expect(restoreFailed.inspection).toMatchObject({ bootstrapStatus: 'restore-failed', permission: 'unavailable' });
    const queryFailed = await bootstrapRestoredHandle(store(new EmptyDirectory()), { queryPermission: async () => { throw new Error('query failed'); } });
    expect(queryFailed.inspection).toMatchObject({ bootstrapStatus: 'permission-check-failed', permission: 'unavailable', handleName: 'restored-fixture' });
    const invalid = { kind: 'directory', name: 'C:/secret', entries: null } as unknown as ExternalDirectoryHandleLike;
    const invalidResult = await bootstrapRestoredHandle(store(invalid), permissions('granted'));
    expect(invalidResult).toMatchObject({ reader: null, inspection: { bootstrapStatus: 'invalid-handle', handleName: null, problemCodes: ['invalid-handle'] } });
  });
});
