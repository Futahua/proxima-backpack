/**
 * Event write operations, over the real store and the real recovery gate.
 *
 * The cases are about the three promises this module makes. **Nothing moves until everything is
 * valid:** every refusal here is followed by an assertion that the store's revisions and bytes are
 * what they were. **A move is a move:** the agent's sentence and a drag compile to the same request,
 * so the case asks for exactly that sentence's outcome and asserts the duration survived to the
 * millisecond. **A resize names what the caller knows:** an end or a duration, with the resulting
 * span validated here rather than by a gesture.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  createEvent,
  deleteEvent,
  resizeEvent,
  rescheduleEvent,
  updateEvent,
  type EventMutationDependencies,
} from '../src/app/eventMutations.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordFileNameFor } from '../src/app/jsonRecordStore.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
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

interface World {
  readonly files: MemoryRecordFiles;
  readonly deps: EventMutationDependencies;
  readonly projectId: OpaqueRecordId;
  state(): Promise<ProximaState>;
  /** Every record file's exact text and revision: the durable store as bytes. */
  bytes(): Promise<Record<string, string>>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1300;
  const deps: EventMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const source = recordStoreStateSource(store);

  const project = await createProject(deps, { name: 'Calendar project', description: 'Holds events' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);

  return {
    files,
    deps,
    projectId: project.recordId,
    state: async () => (await source.load()).state,
    bytes: async () => {
      const entries = await Promise.all((await store.list()).map(async (observation) => {
        const read = await files.readRecordFile(recordFileNameFor(observation.record.id));
        return [observation.record.id, read?.text ?? ''] as const;
      }));
      return Object.fromEntries(entries);
    },
  };
}

async function seed(app: World, overrides: Partial<Parameters<typeof createEvent>[1]> = {}) {
  const created = await createEvent(app.deps, {
    name: 'Kickoff',
    projectId: app.projectId,
    description: 'The first meeting',
    startDate: '2026-09-10T09:00:00.000Z',
    deadline: '2026-09-10T10:30:00.000Z',
    ...overrides,
  });
  if (!created.ok) throw new Error(`seeding the event failed: ${created.reason}`);
  return created;
}

describe('Stage 12 event write operations', () => {
  it('creates an event with the project it names and both ends of its span, and refuses a request that is not one', async () => {
    const app = await world();
    const created = await seed(app);
    // The revision is the record file's write count, so it says which file the write landed in.
    expect(created).toMatchObject({ ok: true, outcome: 'created' });
    expect(created.revision).toBe(`${recordFileNameFor(created.recordId)}@1`);
    expect(created.record).toMatchObject({
      name: 'Kickoff',
      description: 'The first meeting',
      projectId: app.projectId,
      startDate: '2026-09-10T09:00:00.000Z',
      deadline: '2026-09-10T10:30:00.000Z',
      isCompleted: false,
      // The clock is injected, so the creation instant is a fact the case can assert.
      createdAt: new Date(CLOCK_ISO).toISOString(),
    });

    const projection = await app.state();
    expect(projection.events.find((event) => event.id === created.recordId)?.name).toBe('Kickoff');

    const before = await app.bytes();
    const refusals: Array<[string, Parameters<typeof createEvent>[1]]> = [
      ['an event needs a name', { name: '   ', projectId: null, startDate: '2026-09-10T09:00:00.000Z', deadline: '2026-09-10T10:00:00.000Z' }],
      ['an event needs a start that is a real instant', { name: 'No start', projectId: null, startDate: 'tomorrow', deadline: '2026-09-10T10:00:00.000Z' }],
      ['an event needs an end that is a real instant', { name: 'No end', projectId: null, startDate: '2026-09-10T09:00:00.000Z', deadline: '' }],
      ['an event must end after it starts', { name: 'Backwards', projectId: null, startDate: '2026-09-10T10:00:00.000Z', deadline: '2026-09-10T09:00:00.000Z' }],
      // Equal ends are refused too: a zero-length event is a point, not a span, and the calendar
      // could draw it but nothing could resize or reschedule it meaningfully.
      ['an event must end after it starts', { name: 'Zero length', projectId: null, startDate: '2026-09-10T09:00:00.000Z', deadline: '2026-09-10T09:00:00.000Z' }],
    ];

    for (const [detail, request] of refusals) {
      expect(await createEvent(app.deps, request)).toMatchObject({ ok: false, reason: 'validation-refused', detail });
    }

    // A project that is not there is a semantic conflict, not a dangling reference.
    expect(await createEvent(app.deps, {
      name: 'Orphan',
      projectId: idFromLastByte(250),
      startDate: '2026-09-10T09:00:00.000Z',
      deadline: '2026-09-10T10:00:00.000Z',
    })).toMatchObject({ ok: false, reason: 'semantic-conflict' });

    expect(await app.bytes()).toEqual(before);
  });

  it('updates the fields a caller names, leaves the span alone, and refuses a list with nothing in it', async () => {
    const app = await world();
    const created = await seed(app);
    const before = await app.bytes();

    expect(await updateEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, mutations: [] }))
      .toMatchObject({ ok: false, reason: 'validation-refused', detail: 'an update with no field to change is not an update' });
    expect(await updateEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, mutations: [{ kind: 'name', value: ' ' }] }))
      .toMatchObject({ ok: false, reason: 'validation-refused', detail: 'an event needs a name' });
    expect(await updateEvent(app.deps, {
      eventId: created.recordId,
      expectedRevision: created.revision,
      mutations: [{ kind: 'project', value: idFromLastByte(251) }],
    })).toMatchObject({ ok: false, reason: 'semantic-conflict' });
    expect(await app.bytes()).toEqual(before);

    const updated = await updateEvent(app.deps, {
      eventId: created.recordId,
      expectedRevision: created.revision,
      mutations: [
        { kind: 'name', value: 'Kickoff (renamed)' },
        { kind: 'description', value: '' },
        { kind: 'completion', value: true },
      ],
    });
    expect(updated).toMatchObject({ ok: true, outcome: 'updated' });
    if (!updated.ok) throw new Error('expected the update to be accepted');
    expect(updated.record).toMatchObject({
      name: 'Kickoff (renamed)',
      description: '',
      isCompleted: true,
      // The dates are not in this verb's union, so the span is byte-identical.
      startDate: '2026-09-10T09:00:00.000Z',
      deadline: '2026-09-10T10:30:00.000Z',
    });
    // A property is a schema-keyed value, and a key with no schema record is refused rather than
    // written as a field nobody defines.
    expect(await updateEvent(app.deps, {
      eventId: created.recordId,
      expectedRevision: updated.revision,
      mutations: [{ kind: 'property', key: idFromLastByte(252), value: { type: 'text', value: 'x' } }],
    })).toMatchObject({ ok: false, reason: 'semantic-conflict' });
  });

  it('moves an event where an agent asked, retaining its current duration', async () => {
    const app = await world();
    const created = await seed(app);
    const duration = Date.parse('2026-09-10T10:30:00.000Z') - Date.parse('2026-09-10T09:00:00.000Z');

    // "Move event E to 2026-09-10 14:30, retaining its current duration" — one typed request, no
    // geometry, and the duration comes from the record rather than from the caller.
    const moved = await rescheduleEvent(app.deps, {
      eventId: created.recordId,
      expectedRevision: created.revision,
      startDate: '2026-09-10T14:30:00.000Z',
    });
    expect(moved).toMatchObject({ ok: true, outcome: 'rescheduled' });
    if (!moved.ok) throw new Error('expected the reschedule to be accepted');
    expect(moved.record?.startDate).toBe('2026-09-10T14:30:00.000Z');
    expect(Date.parse(moved.record?.deadline ?? '') - Date.parse(moved.record?.startDate ?? '')).toBe(duration);
    // Everything but the span is what it was: a move is a move.
    expect(moved.record).toMatchObject({ name: 'Kickoff', description: 'The first meeting', projectId: app.projectId, isCompleted: false });

    const before = await app.bytes();
    expect(await rescheduleEvent(app.deps, { eventId: created.recordId, expectedRevision: moved.revision, startDate: 'yesterday' }))
      .toMatchObject({ ok: false, reason: 'validation-refused', detail: 'the new start is not a real instant' });
    expect(await app.bytes()).toEqual(before);
  });

  it('resizes by an end or by a duration, and refuses a span that is not a span', async () => {
    const app = await world();
    const first = await seed(app);
    const second = await seed(app, { name: 'Same span', startDate: '2026-09-10T09:00:00.000Z', deadline: '2026-09-10T10:30:00.000Z' });

    const byEnd = await resizeEvent(app.deps, {
      eventId: first.recordId,
      expectedRevision: first.revision,
      target: { kind: 'end', value: '2026-09-10T11:00:00.000Z' },
    });
    const byDuration = await resizeEvent(app.deps, {
      eventId: second.recordId,
      expectedRevision: second.revision,
      target: { kind: 'duration', minutes: 150 },
    });
    expect(byEnd).toMatchObject({ ok: true, outcome: 'resized' });
    expect(byDuration).toMatchObject({ ok: true, outcome: 'resized' });
    if (!byEnd.ok || !byDuration.ok) throw new Error('expected both resizes to be accepted');
    // Two spellings, one outcome: the end a caller named and the end a duration implies agree.
    expect(byEnd.record?.deadline).toBe('2026-09-10T11:00:00.000Z');
    expect(byDuration.record?.deadline).toBe('2026-09-10T11:30:00.000Z');
    expect(byEnd.record?.startDate).toBe('2026-09-10T09:00:00.000Z');
    expect(byEnd.record?.name).toBe('Kickoff');

    const before = await app.bytes();
    const refusals: Array<[string, Parameters<typeof resizeEvent>[1]['target']]> = [
      ['the new end is not a real instant', { kind: 'end', value: 'soon' }],
      ['an event must end after it starts', { kind: 'end', value: '2026-09-10T08:00:00.000Z' }],
      ['an event must end after it starts', { kind: 'end', value: '2026-09-10T09:00:00.000Z' }],
      ['a duration must be a whole number of minutes greater than zero', { kind: 'duration', minutes: 0 }],
      ['a duration must be a whole number of minutes greater than zero', { kind: 'duration', minutes: -30 }],
      ['a duration must be a whole number of minutes greater than zero', { kind: 'duration', minutes: 12.5 }],
    ];
    for (const [detail, target] of refusals) {
      expect(await resizeEvent(app.deps, { eventId: byEnd.recordId, expectedRevision: byEnd.revision, target }))
        .toMatchObject({ ok: false, reason: 'validation-refused', detail });
    }
    expect(await app.bytes()).toEqual(before);
  });

  it('refuses a caller that lost a race with the revision that beat it, and writes nothing', async () => {
    const app = await world();
    const created = await seed(app);
    const winner = await updateEvent(app.deps, {
      eventId: created.recordId,
      expectedRevision: created.revision,
      mutations: [{ kind: 'name', value: 'Won the race' }],
    });
    if (!winner.ok) throw new Error('expected the first update to be accepted');
    const before = await app.bytes();

    // Every write verb refuses a caller holding the revision the loser read, and names the one that
    // beat it so the caller can refetch instead of guessing.
    const attempts = await Promise.all([
      updateEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, mutations: [{ kind: 'name', value: 'Lost' }] }),
      deleteEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision }),
      rescheduleEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, startDate: '2026-09-11T09:00:00.000Z' }),
      resizeEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, target: { kind: 'duration', minutes: 30 } }),
    ]);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ ok: false, reason: 'stale-revision', actualRevision: winner.revision });
    }
    expect(await app.bytes()).toEqual(before);
  });

  it('deletes an event, and reports the second delete as not found rather than as a success', async () => {
    const app = await world();
    const created = await seed(app);
    const deleted = await deleteEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision });
    expect(deleted).toMatchObject({ ok: true, outcome: 'deleted', record: null });

    const projection = await app.state();
    expect(projection.events.some((event) => event.id === created.recordId)).toBe(false);
    expect(await deleteEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision }))
      .toMatchObject({ ok: false, reason: 'not-found' });
    expect(app.files.size).toBe(1);
  });
});
