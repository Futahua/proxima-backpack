/**
 * The semantic envelope on the recurrence writes - the last two event rows, in their own module.
 *
 * `eventRecurrenceActions.ts` does not run through `runEventWrite`: a series rule, an occurrence exception and
 * a series-scoped cancel are their own sequence. They share this file's `runRecurrenceWrite`, which mints the
 * envelope once and - the point of the slice - puts the **scope in the journal's name**: a change to one
 * occurrence is `event.occurrence.change` and a change to the series is `event.series.change`, because both are
 * the same record write with different meaning and a journal that flattened them would leave a reader unable to
 * tell which one a selection meant.
 *
 * The sequence also absorbed three refusals that used to happen in front of it - the event is gone, the plan
 * refuses, there is no write path - each of which would otherwise have needed its own id or left the run
 * uncorrelated.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  clearRecurrenceAction,
  setRecurrenceAction,
  updateOccurrenceAction,
  type RecurrenceWriteOutcome,
} from '../src/app/eventRecurrenceActions.js';
import type { EventWriteDependencies, EventWriteOperations } from '../src/app/eventWriteActions.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { defineCanonicalRecurrenceRule, opaqueRecurrenceSeriesIdFromRandomBytes } from '../src/domain/canonicalRecurrence.js';
import { createEvent, deleteEvent, resizeEvent, rescheduleEvent, updateEvent } from '../src/app/eventMutations.js';
import type { EventMutationDependencies } from '../src/app/eventMutations.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T14:00:00+07:00';
const START = '2026-09-20T09:00:00.000Z';
const END = '2026-09-20T10:00:00.000Z';
const DAILY = defineCanonicalRecurrenceRule({ frequency: 'daily', interval: 1, end: { kind: 'never' } });

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFor(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[14] = 0xa3;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

interface WorldOptions {
  readonly writesAvailable?: boolean;
}

async function world(options: WorldOptions = {}) {
  const files = new MemoryRecordFiles();
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: sequentialIdGenerator(),
  });
  const store = createCanonicalJsonRecordStore(files);
  let serial = 0;
  const mutationDeps: EventMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFor((serial += 1)),
  };
  const created = await createEvent(mutationDeps, {
    name: 'Standup',
    projectId: null,
    startDate: START,
    deadline: END,
  });
  if (!created.ok) throw new Error('seeding the event failed');

  const source = recordStoreStateSource(store);
  let state: ProximaState = (await source.load()).state;
  const audit = recordingAudit();
  const order: string[] = [];

  const operations: EventWriteOperations = {
    createEvent: (request) => createEvent(mutationDeps, request),
    updateEvent: (input) => updateEvent(mutationDeps, input),
    deleteEvent: (input) => deleteEvent(mutationDeps, input),
    rescheduleEvent: (input) => rescheduleEvent(mutationDeps, input),
    resizeEvent: (input) => resizeEvent(mutationDeps, input),
  };

  const deps: EventWriteDependencies = {
    get state() { return state; },
    writes: async () => (options.writesAvailable === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      state = (await source.load()).state;
      return null;
    },
    setRefusal: () => {},
    render: () => { order.push('render'); },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  return {
    deps,
    audit,
    order,
    eventId: created.recordId as string,
    /** Somebody else edits the event through the store, so this shell's copy of it is stale. */
    bumpName: async (eventId: string, name: string): Promise<void> => {
      const fresh = (await source.load()).state;
      const current = fresh.events.find((candidate) => candidate.id === eventId)!;
      const result = await updateEvent(mutationDeps, {
        eventId: current.id as OpaqueRecordId,
        expectedRevision: current.source.revision,
        mutations: [{ kind: 'name', value: name }],
      });
      if (!result.ok) throw new Error(`the other writer was refused: ${result.reason}`);
    },
  };
}

/** Every run reports its id, and the journal keeps the scope in the name. */
function expectJournalled(outcome: RecurrenceWriteOutcome, w: Awaited<ReturnType<typeof world>>, actionType: string): void {
  expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
  expect(w.audit.events.at(-1)).toMatchObject({ requestId: outcome.requestId, actionType });
}

describe('the semantic envelope on the recurrence writes', () => {
  it('journals a rule being set and cleared under their own names', async () => {
    const w = await world();
    const set = await setRecurrenceAction(w.deps, { eventId: w.eventId, rule: DAILY, allocateSeriesId: () => opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])) });
    expect(set).toMatchObject({ ok: true, verb: 'recurrence-set' });
    expectJournalled(set, w, 'event.recurrence.set');
    expect(w.audit.events[0]).toMatchObject({ outcome: 'accepted', entityIds: [set.ok ? set.recordId : ''] });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);

    const cleared = await clearRecurrenceAction(w.deps, { eventId: w.eventId });
    expect(cleared).toMatchObject({ ok: true, verb: 'recurrence-clear' });
    expectJournalled(cleared, w, 'event.recurrence.clear');
  });

  it('says which scope a change meant: one occurrence, or the series', async () => {
    const w = await world();
    await setRecurrenceAction(w.deps, { eventId: w.eventId, rule: DAILY, allocateSeriesId: () => opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8])) });

    const one = await updateOccurrenceAction(w.deps, {
      eventId: w.eventId,
      occurrenceStart: START,
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: '2026-09-20T11:00:00.000Z', deadline: '2026-09-20T12:00:00.000Z' },
    });
    expect(one).toMatchObject({ ok: true, scope: 'occurrence' });
    expectJournalled(one, w, 'event.occurrence.change');

    const series = await updateOccurrenceAction(w.deps, {
      eventId: w.eventId,
      occurrenceStart: START,
      scope: 'series',
      change: { kind: 'reschedule', startDate: '2026-09-20T13:00:00.000Z', deadline: '2026-09-20T14:00:00.000Z' },
    });
    expect(series).toMatchObject({ ok: true, scope: 'series' });
    expectJournalled(series, w, 'event.series.change');
  });

  it('journals a series-scoped cancel as the series change it is, and as a deletion', async () => {
    const w = await world();
    await setRecurrenceAction(w.deps, { eventId: w.eventId, rule: DAILY, allocateSeriesId: () => opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])) });

    const cancelled = await updateOccurrenceAction(w.deps, {
      eventId: w.eventId,
      occurrenceStart: START,
      scope: 'series',
      change: { kind: 'cancel' },
    });

    expect(cancelled).toMatchObject({ ok: true, outcome: 'deleted' });
    expectJournalled(cancelled, w, 'event.series.change');
    expect(w.audit.events.at(-1)).toMatchObject({ outcome: 'accepted' });
  });

  it('absorbs the refusals that used to happen in front of the sequence', async () => {
    const missing = await world();
    const unknown = await clearRecurrenceAction(missing.deps, { eventId: 'pxr_missing' });
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown-event' });
    expect(missing.audit.events[0]).toMatchObject({
      requestId: unknown.requestId,
      actionType: 'event.recurrence.clear',
      outcome: 'rejected',
      entityIds: ['pxr_missing'],
      errorCode: 'unknown-event',
    });
    // Nothing was looked up, resolved or written: the event is the only trace.
    expect(missing.order).toEqual(['audit:rejected']);

    const unavailable = await world({ writesAvailable: false });
    const noPath = await setRecurrenceAction(unavailable.deps, { eventId: unavailable.eventId, rule: DAILY, allocateSeriesId: () => opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10])) });
    expect(noPath).toMatchObject({ ok: false, reason: 'writes-unavailable' });
    expect(unavailable.audit.events[0]).toMatchObject({
      requestId: noPath.requestId,
      actionType: 'event.recurrence.set',
      outcome: 'rejected',
      entityIds: [unavailable.eventId],
      errorCode: 'writes-unavailable',
    });
  });

  it('refuses a plan that cannot be built, inside the envelope rather than before it', async () => {
    const w = await world();
    // An occurrence that the rule does not generate: the plan refuses, and the run is still correlatable.
    const refused = await updateOccurrenceAction(w.deps, {
      eventId: w.eventId,
      occurrenceStart: START,
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: '2026-09-20T11:00:00.000Z', deadline: '2026-09-20T12:00:00.000Z' },
    });

    expect(refused.ok).toBe(false);
    // The reason is the plan's own: an event with no series cannot carry an occurrence exception, and the
    // refusal is answered inside the envelope rather than in front of it.
    expect(refused).toMatchObject({ reason: 'no-series' });
    expect(refused.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events[0]).toMatchObject({
      requestId: refused.requestId,
      actionType: 'event.occurrence.change',
      outcome: 'rejected',
      entityIds: [w.eventId],
      errorCode: 'no-series',
    });
    // A refused plan never reaches the write path, so nothing was resolved and nothing converged.
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a lost race, and converges because the store moved under it', async () => {
    const w = await world();
    await w.bumpName(w.eventId, 'Somebody else got there first');
    w.order.length = 0;

    const lost = await setRecurrenceAction(w.deps, { eventId: w.eventId, rule: DAILY, allocateSeriesId: () => opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11])) });

    expect(lost).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(w.audit.events.at(-1)).toMatchObject({
      requestId: lost.requestId,
      actionType: 'event.recurrence.set',
      outcome: 'rejected',
      entityIds: [w.eventId],
      errorCode: 'stale-revision',
    });
    // A lost race is the one refusal where the surface was already wrong, so it does re-read.
    expect(w.order).toEqual(['refresh', 'render', 'audit:rejected']);
  });
});
