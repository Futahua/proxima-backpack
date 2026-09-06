import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createHttpDirectoryHandle, createHttpPresenceProbe } from '../src/adapters/httpDirectory.js';
import { createExternalDirectoryVault } from '../src/adapters/externalDirectoryVault.js';
import { createZeroWriteWitness } from '../src/app/zeroWriteWitness.js';
import { runAcceptance } from '../tools/agent-accept.mjs';

/**
 * Gate 6Q.1b — the presence capability must survive the adapter chain.
 *
 * The bridge answered presence correctly and the loader consumed it correctly, but
 * the capability reached the reader only because the harness patched it on. A
 * capability bolted on outside the adapter is one the browser path silently lacks
 * and one that can vanish without a test noticing, so these exercise the real
 * chain: createHttpDirectoryHandle → createExternalDirectoryVault → VaultReader.
 */

describe('presence through the adapter chain', () => {
  it('appears on the reader when the source can answer, and not when it cannot', () => {
    const handle = createHttpDirectoryHandle('http://127.0.0.1:4174');

    const withProbe = createExternalDirectoryVault(handle, { presence: createHttpPresenceProbe('http://127.0.0.1:4174') });
    expect(typeof withProbe.presence).toBe('function');

    // A generic OPFS/FSA handle cannot tell missing from unreadable. Staying silent
    // is the honest answer; the loader fails closed on the silence.
    const withoutProbe = createExternalDirectoryVault(handle);
    expect(withoutProbe.presence).toBeUndefined();
  });

  it('maps the bridge answer, and treats anything else as unknown', async () => {
    const original = globalThis.fetch;
    const reply = (body: unknown, ok = true) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    try {
      const probe = createHttpPresenceProbe('http://127.0.0.1:4174');

      globalThis.fetch = reply({ presence: 'present' });
      expect(await probe('Proxima/tasks')).toBe('present');

      globalThis.fetch = reply({ presence: 'missing' });
      expect(await probe('Proxima/tasks')).toBe('missing');

      globalThis.fetch = reply({ presence: 'unknown' });
      expect(await probe('Proxima/tasks')).toBe('unknown');

      // A shape the bridge never sends must not be believed.
      globalThis.fetch = reply({ presence: 'definitely-there' });
      expect(await probe('Proxima/tasks')).toBe('unknown');

      globalThis.fetch = reply({ presence: 'missing' }, false);
      expect(await probe('Proxima/tasks')).toBe('unknown');

      globalThis.fetch = vi.fn(async () => { throw new Error('socket closed'); }) as unknown as typeof fetch;
      expect(await probe('Proxima/tasks')).toBe('unknown');
    } finally { globalThis.fetch = original; }
  });

  it('refuses a non-loopback bridge before making any request', () => {
    expect(() => createHttpPresenceProbe('https://example.com/bridge')).toThrow(/loopback/i);
  });

  it('counts the presence probe as a read, not a violation', async () => {
    const witness = createZeroWriteWitness({
      list: async () => [],
      walk: async () => [],
      read: async () => { throw new Error('unused'); },
      exists: async () => false,
      presence: async () => 'missing',
    });
    expect(await witness.reader.presence?.('Proxima/tasks')).toBe('missing');
    expect(witness.violations).toEqual([]);
    expect(witness.reads.some((entry) => entry.startsWith('presence:'))).toBe(true);
  });
});

describe('bridge-backed absence, end to end', () => {
  it('reports a genuinely missing canonical directory as absent and keeps the run legal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxima-presence-'));
    try {
      // Only events exist. Through the real bridge and adapter chain, the other two
      // must come back absent — before this correction they came back failed,
      // because the capability never reached the reader.
      const events = join(root, 'Proxima', 'events');
      await mkdir(events, { recursive: true });
      await writeFile(join(events, 'e-1.md'), '---\nid: e-1\nname: E\nstartDate: 2026-09-09T10:00:00.000Z\ndeadline: 2026-09-09T11:00:00.000Z\n---\n');

      const report = await runAcceptance({ root });
      expect(report.census?.project.status).toBe('absent');
      expect(report.census?.task.status).toBe('absent');
      expect(report.census?.event.status).toBe('complete');
      expect(report.stages.scanCompleteness).toBe('PASS');
      expect(report.status).toBe('PASS');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45_000);
});
