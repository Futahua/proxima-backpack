import { ianaZone, utcZone, type TimeZone } from '../domain/timeZone.js';

/**
 * The one place allowed to read the machine's zone.
 *
 * The zone is injected everywhere the way "now" is (`src/domain/timeZone.ts`), and the domain
 * is forbidden to read ambient state - which `tests/boundaries.test.ts` enforces, having caught
 * the first draft of that module doing exactly this. So the read lives here, above the domain,
 * in the layer that already knows it is running on somebody's machine, and it happens once: the
 * shell calls this, holds the result, and hands the same zone to every derivation.
 *
 * A platform that cannot name a zone answers UTC rather than guessing an offset from the
 * ambient clock, so the fallback is a zone rather than a silent locale.
 */
export function hostZone(): TimeZone {
  const id = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    return ianaZone(id);
  } catch {
    return utcZone();
  }
}
