import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { chooseStartupSource } from '../src/app/startupSourceChoice.js';
import { createBrowserSource } from '../src/browser/sourceFactory.js';
import { MemoryRecordFiles } from './test-record-store.js';

describe('standalone Proxima source ownership', () => {
  it('chooses an empty record store without an activation marker', async () => {
    const decision = await chooseStartupSource({ store: createCanonicalJsonRecordStore(new MemoryRecordFiles()) });
    expect(decision).toMatchObject({
      kind: 'record-store',
      reason: 'record-store-ready',
      marker: null,
    });
    expect(decision.counts).toEqual({ task: 0, project: 0, event: 0, schema: 0, 'workflow-stage': 0 });
  });

  it('has no bundled vault bytes behind the browser source seam', async () => {
    const source = createBrowserSource();
    const loaded = await source.reader.list('');
    expect(loaded).toEqual([]);
  });
});
