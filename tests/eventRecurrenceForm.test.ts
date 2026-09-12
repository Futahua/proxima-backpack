/**
 * The Event editor's rule control, from the form's values to the record.
 *
 * The checklist's row for `event.recurrence.set`/`clear` was operation-only for as long as the editor's
 * recurrence controls were inert: the verbs existed, the projection carried a rule into the readable world,
 * and no surface reached them. This file is the evidence that one does — `saveEventFormAction` routes a
 * changed rule to those verbs, and the cases below run it over a real store.
 *
 * Three things are asserted rather than assumed:
 *
 * - **The rule's unasked parts are derived from the record's own start.** A weekly rule repeats on the
 *   weekday the event is already on, a monthly one on its day, a yearly one in its month and day — because
 *   the domain states the owner's start *is* the anchor, so asking a reader to retype it would be asking for
 *   a chance to disagree with the record.
 * - **A rule this vocabulary cannot read is refused, not cleared.** A series on two weekdays is stored and
 *   shown as a gap by the projection; a form that read that as "does not recur" would delete a rule nobody
 *   could see, so the save refuses and the record is left exactly as it was.
 * - **One Save is one write or two, and both halves land.** Changing a field and the rule together writes the
 *   field update and then the series verb, and the stored record carries both.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, updateEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import { eventFormValuesFor, planEventRecurrenceWrite, type EventFormValues } from '../src/app/eventFormPlan.js';
import { saveEventFormAction } from '../src/app/eventWriteActions.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import type { EventWriteDependencies } from '../src/app/eventWriteActions.js';
import type { RefreshResult } from '../src/app/refreshController.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import {
  defineCanonicalRecurrenceRule,
  defineCanonicalRecurrenceSeries,
  opaqueRecurrenceSeriesIdFromRandomBytes,
  type OpaqueRecurrenceSeriesId,
} from '../src/domain/canonicalRecurrence.js';
import type { CanonicalEventRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { CalendarEvent, ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';
const ANCHOR = '2026-09-10T09:00:00.000Z';

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

function seriesIdFromLastByte(value: number): OpaqueRecurrenceSeriesId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecurrenceSeriesIdFromRandomBytes(bytes);
}

async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2400;
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
  let state: ProximaState = (await source.load()).state;
  let seriesSerial = 3000;

  const dependencies = (): EventWriteDependencies => ({
    // Live, like the shell's: one Save can be two writes, and the second must read the revision the first left.
    get state() { return state; },
    writes: async () => ({
      createEvent: async () => { throw new Error('not used here'); },
      updateEvent: async (input) => await updateEvent(deps, input),
      deleteEvent: async () => { throw new Error('not used here'); },
      rescheduleEvent: async () => { throw new Error('not used here'); },
      resizeEvent: async () => { throw new Error('not used here'); },
    }),
    unavailableReason: () => null,
    // The shell's own convergence: every accepted write re-reads, which is what makes the live state above pay.
    refresh: async () => {
      state = (await source.load()).state;
      return { generation: 0 } as unknown as RefreshResult;
    },
    setRefusal: () => undefined,
    render: () => undefined,
    ids: semanticIds(),
    audit: recordingAudit(),
  });

  const sync = async (): Promise<ProximaState> => { state = (await source.load()).state; return state; };

  return {
    eventId: created.recordId,
    sync,
    current: () => state,
    event: (): CalendarEvent => state.events.find((candidate) => candidate.id === created.recordId)!,
    values: (overrides: Partial<EventFormValues> = {}): EventFormValues => ({
      ...eventFormValuesFor(state, created.recordId)!,
      ...overrides,
    }),
    save: async (values: EventFormValues) => await saveEventFormAction(dependencies(), {
      eventId: created.recordId,
      values,
      allocateSeriesId: () => seriesIdFromLastByte(seriesSerial++),
    }),
    /** The series as the record holds it, which is where the claim is settled. */
    series: async () => {
      const observation = await store.read(created.recordId);
      return observation?.kind === 'event' ? (observation.record as CanonicalEventRecordV2).recurrence : null;
    },
    /** Write a series the readable vocabulary cannot express, so the refusal case has something to protect. */
    storeUnreadableSeries: async () => {
      const written = await updateEvent(deps, {
        eventId: created.recordId,
        expectedRevision: (await store.read(created.recordId))!.observedRevision,
        mutations: [{
          kind: 'recurrence',
          value: defineCanonicalRecurrenceSeries({
            seriesId: seriesIdFromLastByte(99),
            ownerKind: 'event',
            ownerRecordId: created.recordId,
            rule: { frequency: 'weekly', interval: 1, weekdays: ['mon', 'wed'], end: { kind: 'never' } },
          }),
        }],
      });
      if (!written.ok) throw new Error(`storing the two-weekday rule failed: ${written.reason}`);
    },
  };
}

const DAILY = defineCanonicalRecurrenceRule({ frequency: 'daily', interval: 1, end: { kind: 'never' } });

describe('the rule a form describes', () => {
  it('derives the parts the form does not ask for from the record own start', () => {
    const event = { properties: { recurrenceRule: DAILY } };

    // Nothing changed: no rule write at all.
    expect(planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'series', frequency: 'daily', interval: 1, end: { kind: 'never' } } }))).toEqual({ kind: 'none' });

    // A weekly rule repeats on the weekday the event is already on - 2026-09-10 is a Thursday.
    const weekly = planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'series', frequency: 'weekly', interval: 2, end: { kind: 'never' } } }));
    expect(weekly).toMatchObject({ kind: 'set' });
    if (weekly.kind === 'set') {
      expect(weekly.rule).toMatchObject({ frequency: 'weekly', interval: 2, weekdays: ['thu'] });
    }

    // Monthly and yearly take the day, and the year takes the month.
    const monthly = planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'series', frequency: 'monthly', interval: 1, end: { kind: 'count', count: 4 } } }));
    if (monthly.kind === 'set') expect(monthly.rule).toMatchObject({ frequency: 'monthly', dayOfMonth: 10, end: { kind: 'count', count: 4 } });
    const yearly = planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'series', frequency: 'yearly', interval: 1, end: { kind: 'until', until: '2027-09-10T09:00:00.000Z' } } }));
    if (yearly.kind === 'set') expect(yearly.rule).toMatchObject({ frequency: 'yearly', month: 9, dayOfMonth: 10, end: { kind: 'until', until: '2027-09-10T09:00:00.000Z' } });

    // Turning the rule off is a clear, not an edit.
    expect(planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'none' } }))).toEqual({ kind: 'clear' });

    // A form value the domain refuses comes back as the domain's own sentence rather than as a write.
    const bad = planEventRecurrenceWrite(event, baseValues({ recurrence: { kind: 'series', frequency: 'daily', interval: 1, end: { kind: 'count', count: 0 } } }));
    expect(bad).toMatchObject({ kind: 'refused' });
  });

  it('refuses to rewrite a stored rule this vocabulary cannot read', () => {
    // The projection reports a two-weekday series as a gap and carries no rule, which is the shape a form
    // would otherwise read as "does not recur".
    const unreadable = { properties: { recurrence: { frequency: 'weekly' }, recurrenceSeries: { seriesId: 'pxs_x', exceptions: [] } } };
    const plan = planEventRecurrenceWrite(unreadable, baseValues({ recurrence: { kind: 'none' } }));
    expect(plan).toMatchObject({ kind: 'refused' });
    if (plan.kind === 'refused') expect(plan.detail).toContain('cannot be read');
  });
});

describe('the editor writes the rule through its own verbs', () => {
  it('sets a rule, replaces it without losing the series, and clears it', async () => {
    const app = await world();
    expect(app.values().recurrence).toEqual({ kind: 'none' });

    const set = await app.save(app.values({ recurrence: { kind: 'series', frequency: 'daily', interval: 1, end: { kind: 'never' } } }));
    expect(set).toMatchObject({ ok: true, outcome: 'updated', recurrence: 'set' });
    const first = await app.series();
    expect(first).toMatchObject({ ownerKind: 'event', rule: { frequency: 'daily', interval: 1 } });

    // A second rule keeps the series id: changing how often something repeats is not a reason to forget the
    // occurrences a reader already moved.
    await app.sync();
    const changed = await app.save(app.values({ recurrence: { kind: 'series', frequency: 'monthly', interval: 1, end: { kind: 'never' } } }));
    expect(changed).toMatchObject({ ok: true, recurrence: 'set' });
    const second = await app.series();
    expect(second!.seriesId).toBe(first!.seriesId);
    expect(second!.rule).toMatchObject({ frequency: 'monthly', dayOfMonth: 10 });

    // And turning it off clears the record's recurrence rather than rewriting it to "never".
    await app.sync();
    const cleared = await app.save(app.values({ recurrence: { kind: 'none' } }));
    expect(cleared).toMatchObject({ ok: true, recurrence: 'cleared' });
    expect(await app.series()).toBeNull();
  });

  it('writes the fields and the rule in one Save, and both land', async () => {
    const app = await world();
    const saved = await app.save(app.values({
      name: 'Standup (renamed)',
      recurrence: { kind: 'series', frequency: 'weekly', interval: 1, end: { kind: 'never' } },
    }));

    expect(saved).toMatchObject({ ok: true, recurrence: 'set' });
    await app.sync();
    expect(app.event().name).toBe('Standup (renamed)');
    expect(app.event().properties.recurrenceRule).toMatchObject({ frequency: 'weekly', weekdays: ['thu'] });
    expect((await app.series())!.rule).toMatchObject({ frequency: 'weekly', weekdays: ['thu'] });
  });

  it('refuses a Save that would clear a rule it cannot read, and leaves the record alone', async () => {
    const app = await world();
    await app.storeUnreadableSeries();
    await app.sync();

    // The form can only say "does not recur" here, because the stored rule is not in its vocabulary.
    const refused = await app.save(app.values({ recurrence: { kind: 'none' } }));
    expect(refused).toMatchObject({ ok: false, reason: 'validation-refused' });
    if (!refused.ok) expect(refused.detail).toContain('cannot be read');

    const stored = await app.series();
    expect(stored).toMatchObject({ rule: { frequency: 'weekly', weekdays: ['mon', 'wed'] } });
  });
});

/** The values a form would hold for the fixture event, so the unit cases need no store. */
function baseValues(overrides: Partial<EventFormValues> = {}): EventFormValues {
  return {
    name: 'Standup',
    description: '',
    projectId: null,
    startDate: ANCHOR,
    deadline: '2026-09-10T09:15:00.000Z',
    isCompleted: false,
    recurrence: { kind: 'none' },
    ...overrides,
  };
}
