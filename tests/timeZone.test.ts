import { describe, expect, it } from 'vitest';
import { hostZone } from '../src/browser/hostTimeZone.js';
import {
  civilFieldsAt,
  fixedOffsetZone,
  ianaZone,
  instantOfCivil,
  utcZone,
  type TimeZone,
} from '../src/domain/timeZone.js';

/**
 * Gate 1's last open box asks whether the zone becomes explicit and injected. This is the
 * foundation for that answer, so its correctness is the whole point of the suite: an injected
 * zone that is wrong around a transition is worse than the ambient one it replaces, because it
 * looks testable.
 *
 * Every case names its own zone. Nothing here reads the ambient zone, so the suite answers the
 * same on a machine in Bangkok and a machine in Berlin - which is also what the already-ticked
 * "tests are deterministic across CI/developer timezone differences" box needs from the layer
 * underneath it.
 */
const UTC = utcZone();
const KOLKATA = ianaZone('Asia/Kolkata'); // +05:30, no transitions in living memory
const BERLIN = ianaZone('Europe/Berlin'); // both transitions, both directions
const SYDNEY = ianaZone('Australia/Sydney'); // southern hemisphere, opposite seasons
const NEW_YORK = ianaZone('America/New_York'); // the zone a wrong sign shows up in first

describe('an injected civil-time zone', () => {
  it('measures a fixed offset without a database lookup', () => {
    const zone = fixedOffsetZone('UTC+05:30', 330);
    expect(zone.offsetMinutesAt(0)).toBe(330);
    expect(zone.offsetMinutesAt(Date.UTC(2030, 0, 1))).toBe(330);
    expect(utcZone().offsetMinutesAt(Date.UTC(1969, 6, 20))).toBe(0);
  });

  it('refuses an offset that is not a zone offset', () => {
    expect(() => fixedOffsetZone('bad', 16 * 60 + 1)).toThrow(/within sixteen hours/);
    expect(() => fixedOffsetZone('bad', Number.NaN)).toThrow(/within sixteen hours/);
  });

  it('reads the platform zone database for a real zone', () => {
    expect(KOLKATA.offsetMinutesAt(Date.UTC(2026, 5, 1))).toBe(330);
    expect(NEW_YORK.offsetMinutesAt(Date.UTC(2026, 0, 15))).toBe(-300);
    expect(NEW_YORK.offsetMinutesAt(Date.UTC(2026, 6, 15))).toBe(-240);
    // The sign is the thing a hand-written table gets wrong.
    expect(SYDNEY.offsetMinutesAt(Date.UTC(2026, 0, 15))).toBe(660);
    expect(SYDNEY.offsetMinutesAt(Date.UTC(2026, 6, 15))).toBe(600);
  });

  it('refuses a zone id the platform does not know instead of approximating it', () => {
    expect(() => ianaZone('Mars/Olympus_Mons')).toThrow(/not known to this platform/);
  });

  it('converts an instant to the civil fields that zone shows', () => {
    const instant = Date.UTC(2026, 8, 12, 18, 30, 0); // 2026-09-12T18:30:00Z
    expect(civilFieldsAt(instant, UTC)).toEqual({ year: 2026, month: 9, day: 12, hour: 18, minute: 30, second: 0 });
    expect(civilFieldsAt(instant, KOLKATA)).toEqual({ year: 2026, month: 9, day: 13, hour: 0, minute: 0, second: 0 });
    expect(civilFieldsAt(instant, NEW_YORK)).toEqual({ year: 2026, month: 9, day: 12, hour: 14, minute: 30, second: 0 });
    expect(civilFieldsAt(instant, SYDNEY)).toEqual({ year: 2026, month: 9, day: 13, hour: 4, minute: 30, second: 0 });
  });

  it('renders midnight as hour zero rather than hour twenty-four', () => {
    // Some engines render `hour12: false` midnight as 24; the zone layer must not carry that.
    expect(civilFieldsAt(Date.UTC(2026, 0, 1, 0, 0, 0), UTC).hour).toBe(0);
    expect(civilFieldsAt(Date.UTC(2026, 0, 1, 0, 0, 0), BERLIN).hour).toBe(1);
  });

  it('round-trips an instant through a zone in both directions', () => {
    for (const zone of [UTC, KOLKATA, BERLIN, SYDNEY, NEW_YORK]) {
      for (const instant of [
        Date.UTC(2026, 0, 1, 0, 0, 0),
        Date.UTC(2026, 2, 29, 12, 0, 0),
        Date.UTC(2026, 9, 25, 12, 0, 0),
        Date.UTC(1999, 11, 31, 23, 59, 59),
      ]) {
        const fields = civilFieldsAt(instant, zone);
        // Round-tripping through civil fields is exact for whole seconds.
        expect(instantOfCivil(fields, zone)).toBe(instant);
      }
    }
  });

  it('resolves a spring-forward gap deterministically to the offset after the transition', () => {
    // Berlin skips 02:00-03:00 on 2026-03-29; the fields do not exist in that zone.
    const inGap = { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 };
    const resolved = instantOfCivil(inGap, BERLIN);
    expect(resolved).toBe(Date.UTC(2026, 2, 29, 1, 30, 0));
    // Deterministic: the same input answers the same instant, and it is a real instant in the
    // zone even though the exact fields were skipped.
    expect(instantOfCivil(inGap, BERLIN)).toBe(resolved);
    expect(civilFieldsAt(resolved, BERLIN)).toEqual({ year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 0 });
  });

  it('resolves a repeated fall-back hour to its first occurrence', () => {
    // Berlin repeats 02:00-03:00 on 2026-10-25.
    const repeated = { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 };
    expect(instantOfCivil(repeated, BERLIN)).toBe(Date.UTC(2026, 9, 25, 0, 30, 0));
    expect(civilFieldsAt(instantOfCivil(repeated, BERLIN), BERLIN)).toEqual(repeated);
  });

  it('keeps a date that is still the previous day in the west', () => {
    // The same instant is two different calendar days: this is exactly what `localDateKey`
    // reading the ambient zone produced, and what an injected zone removes.
    const instant = Date.UTC(2026, 8, 12, 23, 30, 0);
    expect(civilFieldsAt(instant, UTC).day).toBe(12);
    expect(civilFieldsAt(instant, KOLKATA).day).toBe(13);
    expect(civilFieldsAt(instant, NEW_YORK).day).toBe(12);
    expect(civilFieldsAt(instant, NEW_YORK).hour).toBe(19);
  });

  it('answers the same regardless of the ambient zone', () => {
    // The suite's own guarantee: nothing above consults `hostZone()`. This case states that as
    // an assertion rather than as a hope, and it is the property the derivation wiring needs.
    const ambient: TimeZone = hostZone();
    expect(ambient.id.length).toBeGreaterThan(0);
    const instant = Date.UTC(2026, 8, 12, 18, 30, 0);
    expect(civilFieldsAt(instant, KOLKATA)).toEqual({ year: 2026, month: 9, day: 13, hour: 0, minute: 0, second: 0 });
    expect(civilFieldsAt(instant, UTC)).toEqual({ year: 2026, month: 9, day: 12, hour: 18, minute: 30, second: 0 });
  });

  it('reports the host zone as a zone, not as an exception', () => {
    const ambient = hostZone();
    expect(typeof ambient.id).toBe('string');
    expect(Number.isFinite(ambient.offsetMinutesAt(Date.UTC(2026, 8, 12)))).toBe(true);
  });
});
