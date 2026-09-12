/**
 * The semantic envelope on the Schedule's event writes: five verbs, one sequence, one journal name each.
 *
 * `createEventAction`, `saveEventAction`, `deleteEventAction`, `rescheduleEventAction` and `resizeEventAction`
 * all run through `runEventWrite`, so the envelope is minted once rather than five times - and the journal names
 * the verb as `event.<verb>`, which is the name each of Stage 17's event rows already uses. A create has no id
 * yet, so its refusals name nothing rather than guessing; every other verb's refusal names the event it was
 * refused about, because that is the record a reader would go and look at.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  createEventAction,
  deleteEventAction,
  resizeEventAction,
  rescheduleEventAction,
  saveEventAction,
  type EventWriteDependencies,
  type EventWriteOperations,
} from '../src/app/eventWriteActions.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { SEMANTIC_REQUEST_PREFIX } from '../src/app/semanticAudit.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import type { IdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { createEvent, deleteEvent, resizeEvent, rescheduleEvent, updateEvent } from '../src/app/eventMutations.js';
import type { EventMutationDependencies } from '../src/app/eventMutations.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import type { ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T13:30:00+07:00';
const START = '2026-09-20T09:00:00.000Z';
const END = '2026-09-20T10:00:00.000Z';

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
  bytes[14] = 0xa2;
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

  const values = { name: 'Kickoff', description: '', projectId: null, startDate: START, deadline: END, isCompleted: false };

  return {
    deps,
    audit,
    order,
    values,
    eventId: (): string => state.events[0]!.id as string,
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

describe('the semantic envelope on the Schedule writes', () => {
  it('mints an id on a create and journals it as event.create', async () => {
    const w = await world();
    const outcome = await createEventAction(w.deps, { values: w.values });

    expect(outcome.ok).toBe(true);
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'event.create',
      outcome: 'accepted',
      entityIds: [outcome.ok ? outcome.recordId : ''],
    });
    expect(w.order).toEqual(['refresh', 'render', 'audit:accepted']);
  });

  it('names each verb, so one sequence still tells five stories', async () => {
    const w = await world();
    const created = await createEventAction(w.deps, { values: w.values });
    expect(created.ok).toBe(true);
    const eventId = created.ok ? (created.recordId as string) : '';

    await saveEventAction(w.deps, { eventId, values: { ...w.values, name: 'Kickoff (renamed)' } });
    await rescheduleEventAction(w.deps, { eventId, startDate: '2026-09-21T09:00:00.000Z' });
    await resizeEventAction(w.deps, { eventId, target: { kind: 'end', value: '2026-09-21T11:00:00.000Z' } });
    await deleteEventAction(w.deps, { eventId });

    expect(w.audit.events.map((event) => [event.actionType, event.outcome])).toEqual([
      ['event.create', 'accepted'],
      ['event.update', 'accepted'],
      ['event.reschedule', 'accepted'],
      ['event.resize', 'accepted'],
      ['event.delete', 'accepted'],
    ]);
    // Five runs, five events, each with its own id: the journal is per run, not per module.
    expect(new Set(w.audit.events.map((event) => event.requestId)).size).toBe(5);
  });

  it('names the event on a refusal, and the reason it was refused', async () => {
    const w = await world();
    const created = await createEventAction(w.deps, { values: w.values });
    const eventId = created.ok ? (created.recordId as string) : '';

    const outcome = await saveEventAction(w.deps, { eventId, values: w.values });

    expect(outcome.ok).toBe(false);
    expect(w.audit.events[1]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'event.update',
      outcome: 'rejected',
      entityIds: [eventId],
    });
    expect(w.audit.events[1]!.errorCode).toBeDefined();
  });

  it('refuses an event the schedule does not hold, with the envelope rather than without it', async () => {
    const w = await world();
    const outcome = await deleteEventAction(w.deps, { eventId: 'pxr_missing' });

    expect(outcome).toMatchObject({ ok: false, reason: 'unknown-event', verb: 'delete' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'event.delete',
      outcome: 'rejected',
      entityIds: ['pxr_missing'],
      errorCode: 'unknown-event',
    });
    // The refusal happens before any write path is resolved, so nothing was attempted at all.
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('correlates a create with no write path, naming no target because none exists yet', async () => {
    const w = await world({ writesAvailable: false });
    const outcome = await createEventAction(w.deps, { values: w.values });

    expect(outcome).toMatchObject({ ok: false, reason: 'writes-unavailable', verb: 'create' });
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'event.create',
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'writes-unavailable',
    });
  });

  it('correlates a lost race, and converges because the store moved under it', async () => {
    const w = await world();
    const created = await createEventAction(w.deps, { values: w.values });
    const eventId = created.ok ? (created.recordId as string) : '';
    // The shell's copy of the event is now stale: the write carries the revision it was rendered at.
    await w.bumpName(eventId, 'Somebody else got there first');
    w.order.length = 0;

    const outcome = await rescheduleEventAction(w.deps, { eventId, startDate: '2026-09-22T09:00:00.000Z' });

    expect(outcome).toMatchObject({ ok: false, reason: 'stale-revision' });
    expect(w.audit.events.at(-1)).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'event.reschedule',
      outcome: 'rejected',
      entityIds: [eventId],
      errorCode: 'stale-revision',
    });
    // A lost race is the one refusal where the surface was already wrong, so it does re-read.
    expect(w.order).toEqual(['refresh', 'render', 'audit:rejected']);
  });
});
