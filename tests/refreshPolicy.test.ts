import { describe, expect, it } from 'vitest';
import { createRefreshPolicy, MIN_REFRESH_INTERVAL_MS, type RefreshScheduler } from '../src/app/refreshPolicy.js';
import type { RefreshReason, RefreshResult } from '../src/app/refreshController.js';

function result(reason: RefreshReason): RefreshResult {
  return { ok: true, reason, outcome: 'unchanged', changed: false, snapshot: {} as RefreshResult['snapshot'] };
}

function schedulerHarness() {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: RefreshScheduler = {
    setInterval(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
    clearInterval(handle) { callbacks.delete(handle as number); },
  };
  return { scheduler, callbacks };
}

describe('Gate 6C refresh trigger policy', () => {
  it('clamps polling, makes start idempotent, and disposes its timer', () => {
    const harness = schedulerHarness();
    const policy = createRefreshPolicy({ controller: { refreshSource: async (reason) => result(reason) }, intervalMs: 5, scheduler: harness.scheduler });
    expect(policy.snapshot()).toMatchObject({ enabled: true, intervalMs: MIN_REFRESH_INTERVAL_MS, timerActive: false });
    policy.start();
    policy.start();
    expect(harness.callbacks.size).toBe(1);
    expect(policy.snapshot().timerActive).toBe(true);
    policy.stop();
    expect(harness.callbacks.size).toBe(0);
    policy.dispose();
    policy.start();
    expect(harness.callbacks.size).toBe(0);
  });

  it('coalesces trigger storms behind one in-flight refresh and keeps the later reason', async () => {
    const harness = schedulerHarness();
    let resolveFirst!: (value: RefreshResult) => void;
    const calls: RefreshReason[] = [];
    const first = new Promise<RefreshResult>((resolve) => { resolveFirst = resolve; });
    const controller = { refreshSource: (reason: RefreshReason) => { calls.push(reason); return calls.length === 1 ? first : Promise.resolve(result(reason)); } };
    const policy = createRefreshPolicy({ controller, scheduler: harness.scheduler });
    policy.start();
    const firstRun = policy.trigger('manual');
    const coalescedFocus = policy.trigger('focus');
    const coalescedInterval = policy.trigger('interval');
    expect(calls).toEqual(['manual']);
    expect(coalescedFocus).toBeInstanceOf(Promise);
    expect(policy.snapshot()).toMatchObject({ lastTriggerReason: 'interval', triggerCount: 3, coalescedTriggerCount: 2 });
    resolveFirst(result('manual'));
    await firstRun;
    await coalescedFocus;
    await coalescedInterval;
    await Promise.resolve();
    expect(calls).toEqual(['manual', 'focus']);
  });

  it('suspends interval polling while hidden and refreshes once on return', async () => {
    const harness = schedulerHarness();
    const calls: RefreshReason[] = [];
    const policy = createRefreshPolicy({ controller: { refreshSource: async (reason) => { calls.push(reason); return result(reason); } }, scheduler: harness.scheduler, intervalMs: 2_000 });
    policy.start();
    expect(harness.callbacks.size).toBe(1);
    policy.setVisible(false);
    expect(policy.snapshot()).toMatchObject({ visible: false, timerActive: false });
    policy.setVisible(true);
    await Promise.resolve();
    expect(calls).toEqual(['focus']);
    expect(policy.snapshot()).toMatchObject({ visible: true, timerActive: true });
  });

  it('stops pending follow-up work on disposal and never retries a failed refresh by itself', async () => {
    const harness = schedulerHarness();
    const calls: RefreshReason[] = [];
    const policy = createRefreshPolicy({ controller: { refreshSource: async (reason) => { calls.push(reason); return { ...result(reason), ok: false, outcome: 'unreadable' }; } }, scheduler: harness.scheduler });
    policy.start();
    await policy.trigger('manual');
    expect(calls).toEqual(['manual']);
    expect(policy.snapshot().triggerCount).toBe(1);
    policy.dispose();
    expect(await policy.trigger('focus')).toBeNull();
    expect(calls).toEqual(['manual']);
  });
});
