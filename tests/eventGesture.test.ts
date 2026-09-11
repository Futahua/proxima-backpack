/**
 * Gesture geometry, and the two claims the checklist makes about it.
 *
 * The first is that a drag and an agent's sentence produce the **same semantic request**. That is
 * asserted the only way it can be: the request this module computes is handed straight to the real
 * `rescheduleEvent`/`resizeEvent` over a real store, and the record that comes back is compared with
 * what a direct call would have produced.
 *
 * The second is the boundary between snapping and validation. Snapping is a gesture rule — a pointer
 * that moved seven pixels at eight pixels a slot means one slot — while a duration that would leave
 * no time is refused *before* it becomes a request. An agent asking for 14:37 is not snapped, which
 * is the other half of the same boundary and is asserted in `tests/eventMutations.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, rescheduleEvent, resizeEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import {
  dragIsNoop,
  provisionalSpan,
  rescheduleRequestFromDrag,
  resizeTargetFromDrag,
  slotIndexForInstant,
  slotInstant,
  snappedSlotDelta,
} from '../src/app/eventGesture.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';
const SLOT_HEIGHT = 8;

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

async function store() {
  const files = new MemoryRecordFiles();
  const backend = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1400;
  const deps: EventMutationDependencies = {
    store: backend,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Gesture project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);

  return {
    deps,
    event: async (startDate: string, deadline: string) => {
      const created = await createEvent(deps, { name: 'Dragged', projectId: project.recordId, startDate, deadline });
      if (!created.ok) throw new Error(`seeding the event failed: ${created.reason}`);
      return created;
    },
  };
}

describe('Stage 12 schedule gesture geometry', () => {
  it('snaps a pointer delta to whole fifteen-minute slots, ties away from zero', () => {
    // One slot is eight pixels here, which is the height the grid draws.
    expect(snappedSlotDelta(0, SLOT_HEIGHT)).toBe(0);
    expect(snappedSlotDelta(3, SLOT_HEIGHT)).toBe(0);
    expect(snappedSlotDelta(4, SLOT_HEIGHT)).toBe(1);
    expect(snappedSlotDelta(7, SLOT_HEIGHT)).toBe(1);
    expect(snappedSlotDelta(12, SLOT_HEIGHT)).toBe(2);
    expect(snappedSlotDelta(-4, SLOT_HEIGHT)).toBe(-1);
    expect(snappedSlotDelta(-12, SLOT_HEIGHT)).toBe(-2);
    // A pointer that moved nothing, or a grid that claims a nonsense height, cannot move a block.
    expect(snappedSlotDelta(9, 0)).toBe(0);
    expect(snappedSlotDelta(Number.NaN, SLOT_HEIGHT)).toBe(0);
    expect(dragIsNoop({ startDate: '2026-09-10T09:00:00.000Z', deadline: '2026-09-10T10:00:00.000Z', slotDelta: 0 })).toBe(true);
  });

  it('crosses into the next day by arithmetic on the instant rather than by clamping to a column', () => {
    const late = { startDate: '2026-09-10T23:30:00.000Z', deadline: '2026-09-11T00:15:00.000Z', slotDelta: 6 };
    const span = provisionalSpan(late);
    expect(span).toEqual({ startDate: '2026-09-11T01:00:00.000Z', deadline: '2026-09-11T01:45:00.000Z' });
    // The duration is whatever the reader was looking at, to the millisecond: a move is a move.
    expect(Date.parse((span as { deadline: string }).deadline) - Date.parse((span as { startDate: string }).startDate)).toBe(45 * 60_000);
    expect(rescheduleRequestFromDrag(late)).toEqual({ ok: true, startDate: '2026-09-11T01:00:00.000Z' });

    // And back the other way, which is the case a column-clamped gesture gets wrong.
    const backwards = { startDate: '2026-09-10T00:15:00.000Z', deadline: '2026-09-10T01:00:00.000Z', slotDelta: -4 };
    expect(rescheduleRequestFromDrag(backwards)).toEqual({ ok: true, startDate: '2026-09-09T23:15:00.000Z' });
  });

  it('turns a drag into the request the operation accepts, and writes what a direct call would', async () => {
    const app = await store();
    const dragged = await app.event('2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');
    const direct = await app.event('2026-09-10T09:00:00.000Z', '2026-09-10T10:30:00.000Z');

    // A pointer moved 40 pixels down the day column: five slots, one hour and a quarter.
    const gesture = { startDate: dragged.record!.startDate, deadline: dragged.record!.deadline, slotDelta: snappedSlotDelta(40, SLOT_HEIGHT) };
    expect(gesture.slotDelta).toBe(5);
    const request = rescheduleRequestFromDrag(gesture);
    expect(request).toEqual({ ok: true, startDate: '2026-09-10T10:15:00.000Z' });

    const fromGesture = await rescheduleEvent(app.deps, { eventId: dragged.recordId, expectedRevision: dragged.revision, startDate: (request as { startDate: string }).startDate });
    const fromAgent = await rescheduleEvent(app.deps, { eventId: direct.recordId, expectedRevision: direct.revision, startDate: '2026-09-10T10:15:00.000Z' });
    expect(fromGesture).toMatchObject({ ok: true, outcome: 'rescheduled' });
    expect(fromAgent.ok && fromGesture.ok).toBe(true);
    if (!fromGesture.ok || !fromAgent.ok) throw new Error('expected both reschedules to be accepted');
    // Same semantic request, same record: the ids differ because the events do, and nothing else does.
    expect({ ...fromGesture.record, id: 'same' }).toEqual({ ...fromAgent.record, id: 'same' });
  });

  it('refuses a resize that would leave no duration, before it becomes a request', () => {
    const ninety = { startDate: '2026-09-10T09:00:00.000Z', deadline: '2026-09-10T10:30:00.000Z' };
    // Pulling the bottom edge up leaves a quarter of an hour, which is the shortest event there is.
    expect(resizeTargetFromDrag({ ...ninety, slotDelta: -5 })).toEqual({ ok: true, target: { kind: 'duration', minutes: 15 } });
    // One slot further and the duration is zero: there is no event left, so nothing is submitted.
    expect(resizeTargetFromDrag({ ...ninety, slotDelta: -6 })).toEqual({ ok: false, reason: 'invalid-duration' });
    expect(resizeTargetFromDrag({ ...ninety, slotDelta: -7 })).toEqual({ ok: false, reason: 'invalid-duration' });
    expect(resizeTargetFromDrag({ ...ninety, slotDelta: -40 })).toEqual({ ok: false, reason: 'invalid-duration' });
    // Growing it is always a request.
    expect(resizeTargetFromDrag({ ...ninety, slotDelta: 6 })).toEqual({ ok: true, target: { kind: 'duration', minutes: 180 } });
    // A surface rendering nonsense cannot produce a request either.
    expect(resizeTargetFromDrag({ startDate: 'nonsense', deadline: '2026-09-10T10:30:00.000Z', slotDelta: 1 }))
      .toEqual({ ok: false, reason: 'unknown-instant' });
  });

  it('agrees with the operation about a refused resize, and writes nothing', async () => {
    const app = await store();
    const created = await app.event('2026-09-10T09:00:00.000Z', '2026-09-10T09:15:00.000Z');
    // A fifteen-minute event pulled up by a slot: the gesture refuses it, and the operation refuses
    // a zero duration too — the two agree, which is why the gesture is allowed to answer first.
    const target = resizeTargetFromDrag({ startDate: created.record!.startDate, deadline: created.record!.deadline, slotDelta: -1 });
    expect(target).toEqual({ ok: false, reason: 'invalid-duration' });
    expect(await resizeEvent(app.deps, { eventId: created.recordId, expectedRevision: created.revision, target: { kind: 'duration', minutes: 0 } }))
      .toMatchObject({ ok: false, reason: 'validation-refused', detail: 'a duration must be a whole number of minutes greater than zero' });
    const files = await app.deps.store.list();
    expect(files.find((observation) => observation.record.id === created.recordId)?.observedRevision).toBe(created.revision);
  });

  it('reads a slot and an instant as each other, which is how a click and a block are placed', () => {
    expect(slotInstant('2026-09-10', 0)).toBe('2026-09-10T00:00:00.000Z');
    expect(slotInstant('2026-09-10', 36)).toBe('2026-09-10T09:00:00.000Z');
    expect(slotInstant('2026-09-10', 95)).toBe('2026-09-10T23:45:00.000Z');
    // The grid cannot have produced these, so neither can this.
    expect(slotInstant('2026-09-10', 96)).toBeNull();
    expect(slotInstant('2026-09-10', -1)).toBeNull();
    expect(slotInstant('2026-09-10', 1.5)).toBeNull();
    expect(slotInstant('next tuesday', 4)).toBeNull();

    expect(slotIndexForInstant('2026-09-10T09:00:00.000Z')).toBe(36);
    expect(slotIndexForInstant('2026-09-10T09:14:59.000Z')).toBe(36);
    expect(slotIndexForInstant('2026-09-10T23:45:00.000Z')).toBe(95);
    expect(slotIndexForInstant('nonsense')).toBeNull();
  });
});
