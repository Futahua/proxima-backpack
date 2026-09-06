import { afterEach, describe, expect, it } from 'vitest';
import { pickAndProbeDirectory } from '../src/app/fsaProbe.js';

const originalPicker = (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;

afterEach(() => {
  (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = originalPicker;
});

describe('Gate 5 FSA probe', () => {
  it('enumerates and reads a selected handle without exposing absolute paths', async () => {
    const file = { kind: 'file' as const, name: 'root.txt', async getFile() { return { size: 8, lastModified: 0, async text() { return 'root-v1'; } }; } };
    const nestedFile = { kind: 'file' as const, name: 'child.txt', async getFile() { return { size: 9, lastModified: 0, async text() { return 'child-v1'; } }; } };
    const nested = { kind: 'directory' as const, name: 'nested', async *entries() { yield ['child.txt', nestedFile] as const; } };
    const handle = { kind: 'directory' as const, name: 'Disposable', async *entries() { yield ['root.txt', file] as const; yield ['nested', nested] as const; }, async queryPermission() { return 'granted' as const; } };
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => handle;
    const result = await pickAndProbeDirectory();
    expect(result.schemaVersion).toBe(1);
    expect(result.handleName).toBe('Disposable');
    expect(result.permission).toBe('granted');
    expect(result.entries.map((entry) => entry.path)).toEqual(['nested', 'nested/child.txt', 'root.txt']);
    expect(result.entries.find((entry) => entry.path === 'root.txt')?.textMarker).toBe('root-v1');
    expect(JSON.stringify(result)).not.toContain('C:');
  });
});
