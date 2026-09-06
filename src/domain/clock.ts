/**
 * Time and identity are injected, never read from the ambient environment.
 *
 * Every countdown, age, deadline colour and elastic timeline depends on "now".
 * If "now" is Date.now() buried in a component, no test of any of that is stable.
 */
export interface Clock {
  now(): number;
}

export interface IdGenerator {
  next(prefix?: string): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock frozen at one instant, advanced only explicitly. For fixtures and agent runs. */
export function fixedClock(startIso: string): Clock & { advance(ms: number): void; set(iso: string): void } {
  let current = new Date(startIso).getTime();
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
  };
}

export function randomIdGenerator(): IdGenerator {
  return {
    next: (prefix = 'id') => `${prefix}-${crypto.randomUUID()}`,
  };
}

/** Deterministic ids: same sequence every run, so evidence bundles compare cleanly. */
export function sequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix = 'id') => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${String(next).padStart(4, '0')}`;
    },
  };
}
