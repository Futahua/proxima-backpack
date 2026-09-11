/**
 * Stage 13's write layer: recurrence and occurrence scope, over a real store.
 *
 * The cases are the checklist's acceptance boxes, asserted where they can actually break.
 *
 * **An override is keyed by a slot the rule generates.** `planOccurrenceException` regenerates the
 * occurrence with the domain's own `canonicalOccurrenceSequence`, so an instant the calendar merely
 * displayed cannot become a durable exception — and the case proves it by trying one.
 *
 * **An occurrence-only edit leaves the rest of the series alone.** The case writes one exception, then
 * expands the series again and asserts the *other* slots are exactly where they were, because "does
 * not rewrite unaffected occurrences" is a claim about instants rather than about a diff.
 *
 * **A series edit is a different write.** Moving the series moves the owner record, so every derived
 * occurrence follows, and the overrides the old schedule carried are dropped — asserted, not implied.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import { occurrenceExceptionsOf, planOccurrenceException } from '../src/app/eventRecurrencePlan.js';
import { clearRecurrenceAction, setRecurrenceAction, updateOccurrenceAction } from '../src/app/eventRecurrenceActions.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import type { EventWriteDependencies } from '../src/app/eventWriteActions.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { defineCanonicalRecurrenceRule, opaqueRecurrenceSeriesIdFromRandomBytes } from '../src/domain/canonicalRecurrence.js';
import type { CanonicalEventRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { expandScheduleRecurringOccurrences } from '../src/browser/scheduleRecurrence.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function seriesIdFromLastByte(value: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecurrenceSeriesIdFromRandomBytes(bytes);
}

const ANCHOR = '2026-09-10T09:00:00.000Z';

async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1900;
  const deps: EventMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Recurring project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);
  const created = await createEvent(deps, {
    name: 'Standup',
    projectId: project.recordId,
    startDate: ANCHOR,
    deadline: '2026-09-10T09:15:00.000Z',
  });
  if (!created.ok) throw new Error(`seeding the event failed: ${created.reason}`);

  const source = recordStoreStateSource(store);
  const read = async (): Promise<ProximaState> => (await source.load()).state;
  let state = await read();

  const refreshCalls: string[] = [];
  const dependencies = (): EventWriteDependencies => ({
    state,
    writes: async () => ({
      createEvent: async () => { throw new Error('not used here'); },
      updateEvent: async (input) => await (await import('../src/app/eventMutations.js')).updateEvent(deps, input),
      deleteEvent: async (input) => await (await import('../src/app/eventMutations.js')).deleteEvent(deps, input),
      rescheduleEvent: async (input) => await (await import('../src/app/eventMutations.js')).rescheduleEvent(deps, input),
      resizeEvent: async (input) => await (await import('../src/app/eventMutations.js')).resizeEvent(deps, input),
    }),
    unavailableReason: () => null,
    refresh: async (reason) => { refreshCalls.push(reason); return null; },
    setRefusal: () => undefined,
    render: () => undefined,
  });

  return {
    eventId: created.recordId,
    refreshCalls,
    read,
    /** The world the surface is rendering, which is what every sequence is handed. */
    current: () => state,
    sync: async () => { state = await read(); return state; },
    event: () => state.events.find((event) => event.id === created.recordId)!,
    dependencies,
    /** The series as the record holds it, which is where an override has to land. */
    series: async () => {
      const observation = await store.read(created.recordId);
      return observation?.kind === 'event' ? (observation.record as CanonicalEventRecordV2).recurrence : null;
    },
  };
}

const DAILY = defineCanonicalRecurrenceRule({ frequency: 'daily', interval: 1, end: { kind: 'never' } });

function expand(state: ProximaState, days: number) {
  const start = new Date(ANCHOR);
  return expandScheduleRecurringOccurrences(state.events, {
    start: new Date(start.getTime() - 60 * 60_000),
    end: new Date(start.getTime() + days * 86_400_000),
  }).map((occurrence) => occurrence.startDate);
}

describe('Stage 13 recurrence writes', () => {
  it('sets a rule, keeps the series identity across a rule change, and clears it again', async () => {
    const app = await world();
    const set = await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(11) });
    expect(set).toMatchObject({ ok: true, verb: 'recurrence-set', outcome: 'updated' });
    await app.sync();

    const first = await app.series();
    expect(first?.seriesId).toBe(seriesIdFromLastByte(11));
    expect(first?.exceptions).toEqual([]);
    // The record recurs in the readable world too, which is what makes the projections draw it.
    expect(expand(app.current(), 3)).toEqual([
      ANCHOR,
      '2026-09-11T09:00:00.000Z',
      '2026-09-12T09:00:00.000Z',
    ]);

    // Moving one occurrence, then changing the rule: the override survives and the id does not move.
    await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-11T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: '2026-09-11T14:00:00.000Z', deadline: '2026-09-11T14:15:00.000Z' },
    });
    await app.sync();
    const twice = await setRecurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      rule: defineCanonicalRecurrenceRule({ frequency: 'daily', interval: 2, end: { kind: 'never' } }),
      allocateSeriesId: () => seriesIdFromLastByte(12),
    });
    expect(twice).toMatchObject({ ok: true });
    await app.sync();
    const changed = await app.series();
    expect(changed?.seriesId).toBe(seriesIdFromLastByte(11));
    expect(changed?.rule).toMatchObject({ interval: 2 });
    expect(changed?.exceptions).toHaveLength(1);

    // And clearing stops the recurrence without rewriting the record's own span.
    expect(await clearRecurrenceAction(app.dependencies(), { eventId: app.eventId })).toMatchObject({ ok: true, verb: 'recurrence-clear' });
    await app.sync();
    expect(await app.series()).toBeNull();
    expect(app.event().startDate).toBe(ANCHOR);
    expect(expand(app.current(), 5)).toEqual([]);
  });

  it('writes one exception for one occurrence and leaves every other occurrence where it was', async () => {
    const app = await world();
    await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(21) });
    await app.sync();
    const before = expand(app.current(), 4);

    const moved = await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-12T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: '2026-09-12T16:00:00.000Z', deadline: '2026-09-12T16:15:00.000Z' },
    });
    expect(moved).toMatchObject({ ok: true, verb: 'occurrence-update', scope: 'occurrence', outcome: 'updated' });
    await app.sync();

    const series = await app.series();
    // One exception, keyed by the slot the rule generated rather than by where it moved to.
    expect(series?.exceptions).toEqual([{
      occurrence: { seriesId: seriesIdFromLastByte(21), scheduledStart: '2026-09-12T09:00:00.000Z' },
      state: 'rescheduled',
      startDate: '2026-09-12T16:00:00.000Z',
      deadline: '2026-09-12T16:15:00.000Z',
    }]);
    // The rule is untouched, the record's own span is untouched, and the other slots are exactly
    // where they were: an occurrence-scoped edit changed one occurrence.
    expect(series?.rule).toMatchObject({ frequency: 'daily', interval: 1 });
    expect(app.event().startDate).toBe(ANCHOR);
    const after = expand(app.current(), 4);
    expect(after).toEqual([before[0]!, before[1]!, '2026-09-12T16:00:00.000Z', before[3]!]);

    // Moving the same occurrence again edits its one exception rather than adding a second.
    await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-12T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: '2026-09-12T17:00:00.000Z', deadline: '2026-09-12T17:15:00.000Z' },
    });
    await app.sync();
    expect((await app.series())?.exceptions).toHaveLength(1);
    expect(expand(app.current(), 4)[2]).toBe('2026-09-12T17:00:00.000Z');

    // Cancelling it leaves a hole in the series rather than a record: the slot is gone, the others
    // are not, and the exception says the occurrence was cancelled rather than that it never existed.
    await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-12T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'cancel' },
    });
    await app.sync();
    expect((await app.series())?.exceptions).toEqual([{
      occurrence: { seriesId: seriesIdFromLastByte(21), scheduledStart: '2026-09-12T09:00:00.000Z' },
      state: 'cancelled',
    }]);
    expect(expand(app.current(), 4)).toEqual([before[0]!, before[1]!, before[3]!]);
  });

  it('refuses an override for an instant the rule does not generate', async () => {
    const app = await world();
    await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(31) });
    await app.sync();

    // Half past nine on a generated day is not a slot: a calendar may draw an occurrence at 09:00
    // and a reader may click near it, but nothing may persist an exception for an instant the rule
    // never produces.
    const refused = await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-11T09:30:00.000Z',
      scope: 'occurrence',
      change: { kind: 'cancel' },
    });
    expect(refused).toMatchObject({ ok: false, reason: 'not-a-generated-occurrence' });
    expect((await app.series())?.exceptions).toEqual([]);

    // The planner says the same thing without a store at all, which is where the rule lives.
    expect(planOccurrenceException(app.event(), '2026-09-11T09:30:00.000Z', { kind: 'cancel' }))
      .toMatchObject({ ok: false, reason: 'not-a-generated-occurrence' });
    expect(planOccurrenceException(app.event(), '2026-09-12T09:00:00.000Z', { kind: 'cancel' }))
      .toMatchObject({ ok: true });
    // And an event that does not recur has no slots to override.
    expect(planOccurrenceException({ ...app.event(), properties: {} }, ANCHOR, { kind: 'cancel' }))
      .toMatchObject({ ok: false, reason: 'no-series' });
  });

  it('moves the whole series at series scope, dropping the overrides the old schedule carried', async () => {
    const app = await world();
    await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(41) });
    await app.sync();
    await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-11T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'cancel' },
    });
    await app.sync();
    expect(occurrenceExceptionsOf(app.event())).toHaveLength(1);

    const seriesMove = await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-11T09:00:00.000Z',
      scope: 'series',
      change: { kind: 'reschedule', startDate: '2026-09-20T11:00:00.000Z', deadline: '2026-09-20T11:15:00.000Z' },
    });
    expect(seriesMove).toMatchObject({ ok: true, scope: 'series', outcome: 'updated' });
    await app.sync();

    // The owner record moved, so every derived occurrence moved with it, and the rule is unchanged.
    expect(app.event().startDate).toBe('2026-09-20T11:00:00.000Z');
    expect((await app.series())?.rule).toMatchObject({ frequency: 'daily' });
    // The overrides described the old schedule, so they are gone rather than left dangling.
    expect((await app.series())?.exceptions).toEqual([]);
    expect(expand(app.current(), 30).slice(0, 3)).toEqual([
      '2026-09-20T11:00:00.000Z',
      '2026-09-21T11:00:00.000Z',
      '2026-09-22T11:00:00.000Z',
    ]);

    // A series-scoped cancel deletes the record itself: it is a different request from skipping one
    // occurrence, and it must not be answered with an exception.
    const seriesCancel = await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-21T11:00:00.000Z',
      scope: 'series',
      change: { kind: 'cancel' },
    });
    expect(seriesCancel).toMatchObject({ ok: true, scope: 'series', outcome: 'deleted' });
    await app.sync();
    expect(app.current().events.some((event) => event.id === app.eventId)).toBe(false);
  });

  it('refuses an occurrence update from a caller holding a revision the series no longer has', async () => {
    const app = await world();
    await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(51) });
    await app.sync();
    const stale = app.dependencies();          // the world the surface was rendering

    // Somebody else edits the series first.
    await updateOccurrenceAction(app.dependencies(), {
      eventId: app.eventId,
      occurrenceStart: '2026-09-11T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'cancel' },
    });
    await app.sync();

    const loser = await updateOccurrenceAction(stale, {
      eventId: app.eventId,
      occurrenceStart: '2026-09-12T09:00:00.000Z',
      scope: 'occurrence',
      change: { kind: 'cancel' },
    });
    expect(loser).toMatchObject({ ok: false, reason: 'stale-revision' });
    // A lost race is the one refusal that re-reads, which is what puts the surfaces back on the
    // revision that beat them. The stub declines the re-read, so what is asserted is that it was asked.
    expect(app.refreshCalls).toContain('manual');
    expect(loser.ok ? true : loser.refreshed).toBe(false);
    expect(loser.ok ? '' : loser.detail).toContain('another writer changed this event first');
    // The winner's write is the only one in the series.
    expect((await app.series())?.exceptions).toHaveLength(1);
  });

  it('refuses without a write path, and refuses an event the schedule is not showing', async () => {
    const app = await world();
    await setRecurrenceAction(app.dependencies(), { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(61) });
    await app.sync();
    const withoutWrites: EventWriteDependencies = { ...app.dependencies(), writes: async () => null, unavailableReason: () => 'record-writes-need-an-activated-store' };
    expect(await setRecurrenceAction(withoutWrites, { eventId: app.eventId, rule: DAILY, allocateSeriesId: () => seriesIdFromLastByte(61) }))
      .toMatchObject({ ok: false, verb: 'recurrence-set', reason: 'writes-unavailable' });
    expect(await updateOccurrenceAction(withoutWrites, { eventId: app.eventId, occurrenceStart: ANCHOR, scope: 'occurrence', change: { kind: 'cancel' } }))
      .toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(await updateOccurrenceAction(app.dependencies(), { eventId: 'not-in-the-world', occurrenceStart: ANCHOR, scope: 'series', change: { kind: 'cancel' } }))
      .toMatchObject({ ok: false, reason: 'unknown-event' });
  });
});
