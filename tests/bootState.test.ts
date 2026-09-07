import { describe, expect, it } from 'vitest';
import { applyBootState } from '../src/browser/bootState.js';

describe('Gate 6.5A source-mode safety', () => {
  it('changes lifecycle flags without overwriting the resolved source mode', () => {
    const dataset: Record<string, string> = { proximaMode: 'external', proximaSourceMode: 'external' };
    applyBootState(dataset, 'ready');
    expect(dataset).toMatchObject({ proximaMode: 'external', proximaSourceMode: 'external', proximaHydrated: 'true', proximaBootState: 'ready' });
    applyBootState(dataset, 'error');
    expect(dataset.proximaMode).toBe('external');
    expect(dataset.proximaSourceMode).toBe('external');
  });
});
