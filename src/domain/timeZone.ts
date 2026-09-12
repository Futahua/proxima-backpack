/**
 * The civil-time zone, injected the way "now" is.
 *
 * `clock.ts` settled that the current instant is never read from the ambient environment,
 * because a component that reads the machine clock makes every countdown, deadline colour and
 * elastic timeline untestable. The zone is the same hazard one step further in: reading a
 * date's year, month or hour off a `Date` uses the machine's zone, so a calendar derived that
 * way renders one grid in Bangkok and another in Berlin from identical data, and no fixture can
 * pin either.
 *
 * This module makes the zone an explicit argument, and it deliberately holds **no** ambient
 * reader: the machine's zone is read once, above the domain, by `src/browser/hostTimeZone.ts`.
 * `tests/boundaries.test.ts` enforces that separation, which is how the first draft of this file
 * was caught doing it here.
 *
 * Offsets come from the platform's own zone database through `Intl`, not from a table in
 * this repository: a hand-written table is wrong at the next transition and this project
 * has no business owning one. The cost is one `formatToParts` call per lookup, cached per
 * zone id.
 */
export interface TimeZone {
  /** IANA identifier, or a fixed-offset label such as `UTC+05:30`. */
  readonly id: string;
  /** The zone's offset from UTC in minutes at one instant. Positive is east of UTC. */
  offsetMinutesAt(instant: number): number;
}

export interface CivilFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const MINUTE_MS = 60_000;

/** The zone is a fixed offset: no transitions, no database lookup. */
export function fixedOffsetZone(id: string, offsetMinutes: number): TimeZone {
  if (!Number.isFinite(offsetMinutes) || Math.abs(offsetMinutes) > 16 * 60) {
    throw new Error('a fixed zone offset must be within sixteen hours of UTC');
  }
  return { id, offsetMinutesAt: () => offsetMinutes };
}

export function utcZone(): TimeZone {
  return fixedOffsetZone('UTC', 0);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(id: string): Intl.DateTimeFormat {
  const existing = formatters.get(id);
  if (existing) return existing;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
  } catch {
    // Fail closed with a bounded message: silently falling back to the host zone would make a
    // typo in a zone id render somebody else's calendar, which is worse than refusing.
    throw new Error('time zone id is not known to this platform');
  }
  formatters.set(id, created);
  return created;
}

/**
 * A zone backed by the platform's zone database. An identifier the platform does not know is
 * refused rather than approximated.
 */
export function ianaZone(id: string): TimeZone {
  formatterFor(id);
  return {
    id,
    offsetMinutesAt(instant: number): number {
      return offsetMinutesOf(id, instant);
    },
  };
}

function partsOf(id: string, instant: number): CivilFields & { era: string } {
  const parts = formatterFor(id).formatToParts(new Date(instant));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  // `hour: '2-digit'` with hour12:false renders midnight as 24 in some locales/engines.
  const hour = Number(value('hour')) % 24;
  const year = Number(value('year'));
  return {
    year: value('era').startsWith('B') ? 1 - year : year,
    month: Number(value('month')),
    day: Number(value('day')),
    hour,
    minute: Number(value('minute')),
    second: Number(value('second')),
    era: value('era'),
  };
}

function offsetMinutesOf(id: string, instant: number): number {
  const fields = partsOf(id, instant);
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  // Whole minutes only: a zone offset is never a fraction of a minute, and rounding keeps
  // the arithmetic exact for the pre-1970 LMT offsets some zones still report.
  return Math.round((asUtc - instant) / MINUTE_MS);
}

/** The civil fields one instant falls on in a zone. */
export function civilFieldsAt(instant: number, zone: TimeZone): CivilFields {
  const shifted = new Date(instant + zone.offsetMinutesAt(instant) * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/**
 * The instant a set of civil fields names in a zone.
 *
 * The naive guess treats the fields as UTC, which is exactly wrong by one offset; the offsets
 * that could apply are sampled a day either side of it as well, because a transition's distance
 * from the guess is not bounded by an hour in UTC. Each candidate is kept only if it converts
 * back to the fields it came from, which leaves three branches:
 *
 * - **one candidate** - an ordinary time, or the only side of a transition that exists;
 * - **two candidates** - the hour a fall-back repeats. The *earlier* instant wins, the
 *   convention every platform's own local-time parsing uses;
 * - **no candidate** - the hour a spring-forward skips. The offset from before the transition
 *   resolves it, which shifts the answer forward by the gap, again matching the convention.
 *
 * Every branch is deterministic, and all three are asserted in `tests/timeZone.test.ts`.
 */
export function instantOfCivil(fields: CivilFields, zone: TimeZone): number {
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const aDayEarlier = asUtc - 24 * 60 * MINUTE_MS;
  const aDayLater = asUtc + 24 * 60 * MINUTE_MS;
  const offsets = [...new Set([zone.offsetMinutesAt(aDayEarlier), zone.offsetMinutesAt(asUtc), zone.offsetMinutesAt(aDayLater)])];
  const candidates = offsets
    .map((offset) => asUtc - offset * MINUTE_MS)
    .filter((instant) => {
      const back = civilFieldsAt(instant, zone);
      return back.year === fields.year && back.month === fields.month && back.day === fields.day
        && back.hour === fields.hour && back.minute === fields.minute && back.second === fields.second;
    });
  if (candidates.length > 0) return Math.min(...candidates);
  return asUtc - zone.offsetMinutesAt(aDayEarlier) * MINUTE_MS;
}
