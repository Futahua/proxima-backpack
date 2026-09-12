/**
 * The Schedule's write sequences, and the planning they are built on.
 *
 * Two layers are asserted separately on purpose. `eventFormPlan` is pure arithmetic over the record
 * and the form — what changed, and what a save would submit — so its cases need no store at all.
 * `eventWriteActions` is the sequence: it resolves a write path, submits at the revision the surface
 * was rendering, and re-reads after an accepted write. The cases here execute it against a real store
 * through the recovery gate, because "the save wrote only the changed fields" is a claim about
 * durable bytes rather than about a return value.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, deleteEvent, rescheduleEvent, resizeEvent, updateEvent, type EventMutationDependencies, type EventMutationResult } from '../src/app/eventMutations.js';
import {
  eventFormIsDirty,
  eventFormValuesFor,
  eventSpanIsValid,
  planEventFormMutations,
  seededEventValues,
  type EventFormValues,
} from '../src/app/eventFormPlan.js';
import { createEventAction, deleteEventAction, saveEventAction, type EventWriteDependencies } from '../src/app/eventWriteActions.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CalendarEvent, ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

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

const EVENT: CalendarEvent = {
  id: 'event-1',
  source: { path: 'record-store/records/event-1.json', revision: 'event-1.json@3', kind: 'event', idOrigin: 'record-store' },
  name: 'Kickoff',
  description: 'The first meeting',
  projectId: 'project-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  startDate: '2026-09-10T09:00:00.000Z',
  deadline: '2026-09-10T10:30:00.000Z',
  isCompleted: false,
  properties: {},
};

function values(overrides: Partial<EventFormValues> = {}): EventFormValues {
  return {
    name: EVENT.name,
    description: EVENT.description,
    projectId: EVENT.projectId,
    startDate: EVENT.startDate,
    deadline: EVENT.deadline,
    isCompleted: EVENT.isCompleted,
    ...overrides,
  };
}

describe('Stage 12 the event form, as values', () => {
  it('submits only the fields the form changed, and the two ends as one span', () => {
    expect(planEventFormMutations(EVENT, values())).toEqual([]);
    expect(eventFormIsDirty(EVENT, values())).toBe(false);

    expect(planEventFormMutations(EVENT, values({ name: 'Kickoff (renamed)' }))).toEqual([{ kind: 'name', value: 'Kickoff (renamed)' }]);
    expect(planEventFormMutations(EVENT, values({ description: '' }))).toEqual([{ kind: 'description', value: '' }]);
    expect(planEventFormMutations(EVENT, values({ projectId: null }))).toEqual([{ kind: 'project', value: null }]);
    expect(planEventFormMutations(EVENT, values({ isCompleted: true }))).toEqual([{ kind: 'completion', value: true }]);

    // Either end moving submits both, because a span is the thing that has to be a span.
    expect(planEventFormMutations(EVENT, values({ startDate: '2026-09-10T09:30:00.000Z' })))
      .toEqual([{ kind: 'span', startDate: '2026-09-10T09:30:00.000Z', deadline: EVENT.deadline }]);
    expect(planEventFormMutations(EVENT, values({ deadline: '2026-09-10T11:00:00.000Z' })))
      .toEqual([{ kind: 'span', startDate: EVENT.startDate, deadline: '2026-09-10T11:00:00.000Z' }]);

    // Everything at once, in the order the record declares its fields.
    expect(planEventFormMutations(EVENT, values({ name: 'Later', isCompleted: true, startDate: '2026-09-11T09:00:00.000Z' })))
      .toEqual([
        { kind: 'name', value: 'Later' },
        { kind: 'completion', value: true },
        { kind: 'span', startDate: '2026-09-11T09:00:00.000Z', deadline: EVENT.deadline },
      ]);
  });

  it('opens the editor on the record and seeds an empty cell with a one-hour proposal', () => {
    const state = { events: [EVENT] } as unknown as ProximaState;
    expect(eventFormValuesFor(state, 'event-1')).toEqual(values());
    expect(eventFormValuesFor(state, 'not-there')).toBeNull();

    const seeded = seededEventValues('2026-09-10T13:00:00.000Z', '2026-09-10T14:00:00.000Z');
    expect(seeded).toEqual({
      name: 'New event',
      description: '',
      projectId: null,
      startDate: '2026-09-10T13:00:00.000Z',
      deadline: '2026-09-10T14:00:00.000Z',
      isCompleted: false,
    });
    // A seed is not a record: it becomes one only when somebody saves it.
    expect(eventSpanIsValid(seeded.startDate, seeded.deadline)).toBe(true);
    expect(eventSpanIsValid(seeded.deadline, seeded.startDate)).toBe(false);
    expect(eventSpanIsValid(seeded.startDate, seeded.startDate)).toBe(false);
    expect(eventSpanIsValid('nonsense', seeded.deadline)).toBe(false);
  });
});

async function store() {
  const files = new MemoryRecordFiles();
  const backend = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1500;
  const deps: EventMutationDependencies = {
    store: backend,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Schedule project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);

  const source = recordStoreStateSource(backend);
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    files,
    store: backend,
    source,
    read,
    seed: async (name: string, startDate: string, deadline: string): Promise<OpaqueRecordId> => {
      const created = await createEvent(deps, { name, projectId: project.recordId, startDate, deadline });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      return created.recordId;
    },
    // The operations a resolved write path hands a surface, structurally — the same three callables
    // the browser adapter returns, bound to this world's store.
    operations: {
      createEvent: async (request: Parameters<typeof createEvent>[1]): Promise<EventMutationResult> => await createEvent(deps, request),
      updateEvent: async (input: Parameters<typeof updateEvent>[1]): Promise<EventMutationResult> => await updateEvent(deps, input),
      deleteEvent: async (input: Parameters<typeof deleteEvent>[1]): Promise<EventMutationResult> => await deleteEvent(deps, input),
      rescheduleEvent: async (input: Parameters<typeof rescheduleEvent>[1]): Promise<EventMutationResult> => await rescheduleEvent(deps, input),
      resizeEvent: async (input: Parameters<typeof resizeEvent>[1]): Promise<EventMutationResult> => await resizeEvent(deps, input),
    },
  };
}

/**
 * The shell's refresh, stubbed to the source's own reload — which is what the shell's refresh is, one
 * layer up. The reason is recorded so a case can assert that a lost race is the one refusal that
 * re-reads.
 */
function dependenciesFor(
  app: Awaited<ReturnType<typeof store>>,
  refusals: Array<string | null>,
  renders: { count: number },
  writes: boolean,
  refreshReasons: string[] = [],
): EventWriteDependencies {
  return {
    state: null,
    writes: async () => (writes ? app.operations : null),
    unavailableReason: () => 'record-writes-need-an-activated-store',
    refresh: async (reason) => {
      refreshReasons.push(reason);
      const load = await app.source.load();
      return {
        ok: true,
        reason,
        outcome: 'changed' as const,
        changed: true,
        snapshot: {
          sourceRevision: 2,
          lastSuccessfulRefreshRevision: 2,
          refreshState: 'idle' as const,
          stale: false,
          lastRefreshReason: reason,
          lastRefreshProblemCode: null,
          pendingRefreshCount: 0,
          load,
        },
      };
    },
    setRefusal: (reason) => { refusals.push(reason); },
    render: () => { renders.count += 1; },
    ids: semanticIds(),
    audit: recordingAudit(),
  };
}

describe('Stage 12 the Schedule write sequences', () => {
  it('creates the event a seeded form describes, and refuses a form that is not a span', async () => {
    const app = await store();
    const refusals: Array<string | null> = [];
    const renders = { count: 0 };
    const deps = { ...dependenciesFor(app, refusals, renders, true), state: await app.read() };

    const outcome = await createEventAction(deps, {
      values: seededEventValues('2026-09-10T13:00:00.000Z', '2026-09-10T14:00:00.000Z', 'Seeded event'),
    });
    expect(outcome).toMatchObject({ ok: true, verb: 'create', outcome: 'created', refreshed: true });
    expect((await app.read()).events.find((event) => event.name === 'Seeded event'))
      .toMatchObject({ startDate: '2026-09-10T13:00:00.000Z', deadline: '2026-09-10T14:00:00.000Z', isCompleted: false });
    // The refusal was cleared before the attempt and never set again: an accepted write says nothing.
    expect(refusals).toEqual([null]);
    expect(renders.count).toBe(1);

    const before = (await app.read()).events.length;
    expect(await createEventAction(deps, {
      values: seededEventValues('2026-09-10T14:00:00.000Z', '2026-09-10T13:00:00.000Z', 'Backwards'),
    })).toMatchObject({ ok: false, verb: 'create', reason: 'validation-refused', detail: 'an event must end after it starts' });
    expect((await app.read()).events).toHaveLength(before);
  });

  it('saves the editor by submitting the diff, re-reads, and refuses a save with nothing changed', async () => {
    const app = await store();
    const eventId = await app.seed('Kickoff', '2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');
    const refusals: Array<string | null> = [];
    const renders = { count: 0 };
    const current = (await app.read()).events.find((event) => event.id === eventId)!;
    // The form starts from the record the surface was rendering, which is what makes "only what
    // changed" a real diff rather than a comparison against a fixture.
    const form: EventFormValues = {
      name: current.name,
      description: current.description,
      projectId: current.projectId,
      startDate: current.startDate,
      deadline: current.deadline,
      isCompleted: current.isCompleted,
    };
    const deps = { ...dependenciesFor(app, refusals, renders, true), state: await app.read() };

    const saved = await saveEventAction(deps, {
      eventId,
      values: { ...form, name: 'Kickoff (renamed)', description: 'Rewritten' },
    });
    expect(saved).toMatchObject({ ok: true, verb: 'update', outcome: 'updated', refreshed: true });
    const after = (await app.read()).events.find((event) => event.id === eventId)!;
    expect(after).toMatchObject({ name: 'Kickoff (renamed)', description: 'Rewritten', startDate: current.startDate, deadline: current.deadline });
    expect(after.projectId).toBe(current.projectId);

    // The same form again changes nothing, so the operation refuses it as a no-op and the record
    // keeps its revision.
    const idempotent = await saveEventAction(
      { ...deps, state: await app.read() },
      { eventId, values: { ...form, name: 'Kickoff (renamed)', description: 'Rewritten' } },
    );
    expect(idempotent).toMatchObject({ ok: false, reason: 'validation-refused', detail: 'an update with no field to change is not an update' });
    expect((await app.read()).events.find((event) => event.id === eventId)!.source.revision).toBe(after.source.revision);
  });

  it('refuses a caller that lost a race with the revision that beat it, and re-reads for it', async () => {
    const app = await store();
    const eventId = await app.seed('Kickoff', '2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');
    const stale = await app.read();                 // the world the surface was rendering
    const refusals: Array<string | null> = [];
    const renders = { count: 0 };
    const deps = { ...dependenciesFor(app, refusals, renders, true), state: stale };
    const current = stale.events.find((event) => event.id === eventId)!;

    // Somebody else writes first, from the same revision the surface had.
    const winner = await app.operations.updateEvent({
      eventId,
      expectedRevision: current.source.revision,
      mutations: [{ kind: 'name', value: 'Won the race' }],
    });
    expect(winner).toMatchObject({ ok: true });

    const outcome = await saveEventAction(deps, {
      eventId,
      values: values({ name: 'Loser', startDate: current.startDate, deadline: current.deadline }),
    });
    // A lost race is the one refusal where the surface was already wrong, so the sequence re-reads:
    // that is what puts a dragged block back where the store says it is.
    expect(outcome).toMatchObject({ ok: false, verb: 'update', reason: 'stale-revision', refreshed: true });
    expect(outcome.ok ? '' : outcome.detail).toContain('another writer changed this event first');
    expect(refusals).toContain('stale-revision');
    expect((await app.read()).events.find((event) => event.id === eventId)!.name).toBe('Won the race');
  });

  it('refuses without a write path, naming the reason, and does not resolve one for an event the schedule is not showing', async () => {
    const app = await store();
    const eventId = await app.seed('Kickoff', '2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');
    const refusals: Array<string | null> = [];
    const renders = { count: 0 };
    const withoutWrites = { ...dependenciesFor(app, refusals, renders, false), state: await app.read() };

    expect(await saveEventAction(withoutWrites, { eventId, values: values({ name: 'Nope' }) }))
      .toMatchObject({ ok: false, verb: 'update', reason: 'writes-unavailable', detail: 'record-writes-need-an-activated-store' });
    expect(await deleteEventAction(withoutWrites, { eventId }))
      .toMatchObject({ ok: false, verb: 'delete', reason: 'writes-unavailable' });

    // An id the schedule is not showing is refused before a write path is resolved at all, so a form
    // cannot address a record nobody can see.
    const withWrites = { ...dependenciesFor(app, refusals, renders, true), state: await app.read() };
    expect(await deleteEventAction(withWrites, { eventId: 'not-in-the-world' }))
      .toMatchObject({ ok: false, verb: 'delete', reason: 'unknown-event' });
  });

  it('deletes the event the editor is showing, and the schedule no longer holds it', async () => {
    const app = await store();
    const eventId = await app.seed('Kickoff', '2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');
    const refusals: Array<string | null> = [];
    const renders = { count: 0 };
    const deps = { ...dependenciesFor(app, refusals, renders, true), state: await app.read() };

    expect(await deleteEventAction(deps, { eventId })).toMatchObject({ ok: true, verb: 'delete', outcome: 'deleted', refreshed: true });
    expect((await app.read()).events.some((event) => event.id === eventId)).toBe(false);
  });
});
