import { REFRESH_REASONS, type RefreshController, type RefreshReason, type RefreshResult } from './refreshController.js';

export const MIN_REFRESH_INTERVAL_MS = 1_000;
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const MAX_COUNTER = 1_000_000;

export interface RefreshScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RefreshPolicyOptions {
  controller: Pick<RefreshController, 'refreshSource'>;
  intervalMs?: number;
  enabled?: boolean;
  scheduler?: RefreshScheduler;
  onResult?: (result: RefreshResult) => void;
}

export interface RefreshPolicySnapshot {
  enabled: boolean;
  intervalMs: number;
  lastTriggerReason: RefreshReason | null;
  triggerCount: number;
  coalescedTriggerCount: number;
  timerActive: boolean;
  visible: boolean;
}

export interface RefreshPolicy {
  start(): void;
  stop(): void;
  dispose(): void;
  setVisible(visible: boolean): void;
  trigger(reason: RefreshReason): Promise<RefreshResult | null>;
  snapshot(): RefreshPolicySnapshot;
}

const defaultScheduler: RefreshScheduler = {
  setInterval(callback, intervalMs) { return globalThis.setInterval(callback, intervalMs); },
  clearInterval(handle) { globalThis.clearInterval(handle as number); },
};

function boundedIncrement(value: number): number { return Math.min(MAX_COUNTER, value + 1); }
function isRefreshReason(value: unknown): value is RefreshReason { return typeof value === 'string' && (REFRESH_REASONS as readonly string[]).includes(value); }

/**
 * Owns trigger policy only. It never reads a source; all work converges through
 * the injected controller and browser visibility/timing is supplied by an adapter.
 */
export function createRefreshPolicy(options: RefreshPolicyOptions): RefreshPolicy {
  const scheduler = options.scheduler ?? defaultScheduler;
  const intervalMs = Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS));
  const enabled = options.enabled ?? true;
  let started = false;
  let disposed = false;
  let visible = true;
  let timer: unknown = null;
  let inFlight: Promise<RefreshResult | null> | null = null;
  let pendingReason: RefreshReason | null = null;
  let lastTriggerReason: RefreshReason | null = null;
  let triggerCount = 0;
  let coalescedTriggerCount = 0;

  const snapshot = (): RefreshPolicySnapshot => ({ enabled, intervalMs, lastTriggerReason, triggerCount, coalescedTriggerCount, timerActive: timer !== null, visible });

  const clearTimer = (): void => {
    if (timer === null) return;
    scheduler.clearInterval(timer);
    timer = null;
  };

  const armTimer = (): void => {
    if (!started || disposed || !enabled || !visible || timer !== null) return;
    timer = scheduler.setInterval(() => { void trigger('interval'); }, intervalMs);
  };

  const run = async (reason: RefreshReason): Promise<RefreshResult | null> => {
    try {
      const result = await options.controller.refreshSource(reason);
      try { options.onResult?.(result); } catch { /* observers cannot break refresh ordering */ }
      return result;
    } finally {
      inFlight = null;
      const next = pendingReason;
      pendingReason = null;
      if (next !== null && started && !disposed) void trigger(next);
    }
  };

  const trigger = async (reason: RefreshReason): Promise<RefreshResult | null> => {
    if (disposed || !isRefreshReason(reason) || (reason === 'interval' && !visible)) return null;
    lastTriggerReason = reason;
    triggerCount = boundedIncrement(triggerCount);
    if (inFlight !== null) {
      if (pendingReason === null) pendingReason = reason;
      coalescedTriggerCount = boundedIncrement(coalescedTriggerCount);
      return inFlight;
    }
    inFlight = run(reason);
    return inFlight;
  };

  return {
    start() {
      if (disposed || started) return;
      started = true;
      armTimer();
    },
    stop() {
      if (!started) return;
      started = false;
      pendingReason = null;
      clearTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      pendingReason = null;
      clearTimer();
    },
    setVisible(nextVisible) {
      const wasVisible = visible;
      visible = nextVisible;
      if (!visible) {
        clearTimer();
        return;
      }
      if (started) {
        armTimer();
        if (!wasVisible) void trigger('focus');
      }
    },
    trigger,
    snapshot,
  };
}
