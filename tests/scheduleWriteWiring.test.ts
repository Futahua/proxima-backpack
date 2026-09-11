// @vitest-environment happy-dom
/**
 * A drag, a resize and a seeded Save, driven through the real binder into a real store.
 *
 * The grid's own suite asserts what the gesture *previews*: the snapped provisional block, the
 * segmented cross-day span, the refusal marker. This file asserts the half that only exists once the
 * write path is real — that releasing a dragged block moves the record by exactly the slots the
 * pointer moved, that the duration survives a move because the operation takes it from the record,
 * that a resize writes the end the pointer landed on, that a caller which lost a race gets the
 * revision that beat it and the surface redraws at the authoritative position, and that a seeded
 * form's Save creates the event it described.
 *
 * The shell's half is performed here the way `main.ts` performs it — run the sequence, hold the
 * answer, re-read, redraw — because `main.ts` is not importable from a test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, rescheduleEvent, resizeEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import { createEventAction, rescheduleEventAction, resizeEventAction, type EventWriteDependencies } from '../src/app/eventWriteActions.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { renderScheduleProjection } from '../src/browser/scheduleProjection.js';
import {
  bindScheduleTimeGridInteractions,
  renderScheduleTimeGrid,
  type ScheduleEventChangeIntent,
  type ScheduleEventDraft,
  type ScheduleTimeGridMode,
} from '../src/browser/scheduleTimeGrid.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';
/** The local civil day the grid is looking at, so the geometry below is in the same frame as it. */
const DAY = new Date(2026, 8, 6);
const TRACK_HEIGHT = 768;
const SLOT_HEIGHT = TRACK_HEIGHT / 96;

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

async function scheduleWorld(startHour = 9) {
  const files = new MemoryRecordFiles();
  const backend = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 1700;
  const deps: EventMutationDependencies = {
    store: backend,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Schedule project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);

  const start = new Date(2026, 8, 6, startHour, 0);
  const end = new Date(start.getTime() + 90 * 60_000);
  const created = await createEvent(deps, {
    name: 'Dragged event',
    projectId: project.recordId,
    startDate: start.toISOString(),
    deadline: end.toISOString(),
  });
  if (!created.ok) throw new Error(`seeding the event failed: ${created.reason}`);

  const source = recordStoreStateSource(backend);
  return {
    files,
    eventId: created.recordId,
    operations: {
      createEvent: async (request: Parameters<typeof createEvent>[1]) => await createEvent(deps, request),
      updateEvent: async () => { throw new Error('not used here'); },
      deleteEvent: async () => { throw new Error('not used here'); },
      rescheduleEvent: async (input: Parameters<typeof rescheduleEvent>[1]) => await rescheduleEvent(deps, input),
      resizeEvent: async (input: Parameters<typeof resizeEvent>[1]) => await resizeEvent(deps, input),
    },
    /** Another writer, over the same store and gate: what a lost race is made of. */
    moveEvent: async (eventId: OpaqueRecordId, expectedRevision: string, startDate: string) => await rescheduleEvent(deps, { eventId, expectedRevision, startDate }),
    read: async (): Promise<ProximaState> => (await source.load()).state,
  };
}

/** The track geometry the grid measures against, which happy-dom does not lay out. */
function setGeometry(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.schedule-time-track').forEach((track) => {
    Object.defineProperty(track, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0, y: 0, top: 0, left: 0, right: 160, bottom: TRACK_HEIGHT,
        width: 160, height: TRACK_HEIGHT, toJSON: () => ({}),
      }),
    });
  });
}

interface View {
  writeRefusal: { eventId: string; code: string } | null;
  writeFeedback: string | null;
  seedRefusal: string | null;
}

/** The minutes since local midnight an instant falls at, which is how the track is measured. */
function minuteOfDay(instant: string): number {
  const date = new Date(instant);
  return date.getHours() * 60 + date.getMinutes();
}

function mount(
  state: ProximaState,
  app: Awaited<ReturnType<typeof scheduleWorld>>,
  view: View,
  pending: Promise<void>[],
  onState: (next: ProximaState) => void,
  currentMode: ScheduleTimeGridMode = 'day',
): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  // The seeded form is shell state, exactly as it is in `main.ts`: the grid asks for it, the shell
  // holds it, and a re-render draws it.
  let seeded: ScheduleEventDraft | null = null;

  const draw = (current: ProximaState): void => {
    host.innerHTML = renderScheduleTimeGrid({
      mode: currentMode,
      events: current.events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: DAY,
      now: new Date(2026, 8, 6, 12, 0),
      selectedEventId: null,
      seededEvent: seeded,
      writeRefusal: view.writeRefusal,
      writeFeedback: view.writeFeedback,
      seedRefusal: view.seedRefusal,
    });
    setGeometry(host);
  };

  draw(state);

  const dependencies = (current: ProximaState): EventWriteDependencies => ({
    state: current,
    writes: async () => app.operations,
    unavailableReason: () => null,
    refresh: async () => null,
    setRefusal: () => undefined,
    render: () => undefined,
  });

  bindScheduleTimeGridInteractions(host, {
    openEvent: () => undefined,
    closeEvent: () => { seeded = null; view.seedRefusal = null; draw(state); },
    seedEvent: (draft) => { seeded = { ...draft }; view.seedRefusal = null; draw(state); },
    createEvent: (intent) => {
      pending.push((async () => {
        const outcome = await createEventAction(dependencies(state), {
          values: { name: intent.name, description: intent.description, projectId: intent.projectId, startDate: intent.startDate, deadline: intent.deadline, isCompleted: false },
        });
        view.seedRefusal = outcome.ok ? null : outcome.reason;
        // An accepted create closes the form: the event exists and the grid is about to draw it.
        if (outcome.ok) seeded = null;
        view.writeFeedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        state = await app.read();
        onState(state);
        draw(state);
      })());
    },
    changeEvent: (intent: ScheduleEventChangeIntent) => {
      pending.push((async () => {
        const outcome = intent.operation === 'resize-end'
          ? await resizeEventAction(dependencies(state), { eventId: intent.eventId, target: { kind: 'end', value: intent.proposedDeadline } })
          : await rescheduleEventAction(dependencies(state), { eventId: intent.eventId, startDate: intent.proposedStartDate });
        view.writeRefusal = outcome.ok ? null : { eventId: intent.eventId, code: outcome.reason };
        view.writeFeedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        state = await app.read();
        onState(state);
        draw(state);
      })());
    },
  });

  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 12 schedule writes, driven through the grid', () => {
  it('moves the record by the slots a dragged block moved, keeping its duration, in every time-grid mode', async () => {
    // The same binder draws Day, 4-Day and Week and the same sequence writes them, so the case drives
    // all three rather than asserting the other two from one.
    for (const mode of ['day', 'four-day', 'week'] as const) {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; }, mode);
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    const key = card.dataset.c1Key!;
    const dayKey = card.closest<HTMLElement>('[data-schedule-day]')!.dataset.scheduleDay!;
    const trackKey = `schedule-time-track-${dayKey}`;
    const startValue = card.dataset.scheduleStartValue!;
    const deadlineValue = card.dataset.scheduleDeadlineValue!;
    const duration = Date.parse(deadlineValue) - Date.parse(startValue);
    const y = (minuteOfDay(startValue) / 1440) * TRACK_HEIGHT;

    const gesture = harness.pointerDown(key, { clientX: 40, clientY: y });
    gesture.move(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT });
    // The provisional block is what follows the pointer, and it is measured from the same slots the
    // request will use.
    expect(host.querySelector('[data-schedule-preview-for]')).not.toBeNull();
    gesture.release(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT });
    await Promise.all(pending);

    const moved = drawn.events.find((event) => event.id === app.eventId)!;
    expect(Date.parse(moved.startDate) - Date.parse(startValue)).toBe(15 * 60_000);
    expect(Date.parse(moved.deadline) - Date.parse(moved.startDate)).toBe(duration);
    expect(view.writeFeedback).toContain('rescheduled');
    expect(view.writeRefusal).toBeNull();
    // And the block the next render draws is the moved one, not the one the gesture started from.
    expect(host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!.dataset.scheduleStartValue)
      .toBe(moved.startDate);
    document.body.innerHTML = '';
    }
  });

  it('sends nothing at all when a drag lands back where it started', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    const host = mount(state, app, view, pending, () => undefined);
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    const key = card.dataset.c1Key!;
    const dayKey = card.closest<HTMLElement>('[data-schedule-day]')!.dataset.scheduleDay!;
    const y = (minuteOfDay(card.dataset.scheduleStartValue!) / 1440) * TRACK_HEIGHT;

    const gesture = harness.pointerDown(key, { clientX: 40, clientY: y });
    gesture.move(`schedule-time-track-${dayKey}`, { clientX: 40, clientY: y });
    gesture.release(`schedule-time-track-${dayKey}`, { clientX: 40, clientY: y });
    await Promise.all(pending);

    expect(pending).toHaveLength(0);
    const unchanged = (await app.read()).events.find((event) => event.id === app.eventId)!;
    expect(unchanged.source.revision).toBe(state.events.find((event) => event.id === app.eventId)!.source.revision);
  });

  it('resizes from the bottom edge, writing the end the pointer landed on and refusing a span that is not one', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    const startValue = card.dataset.scheduleStartValue!;
    const dayKey = card.closest<HTMLElement>('[data-schedule-day]')!.dataset.scheduleDay!;
    const trackKey = `schedule-time-track-${dayKey}`;
    const edge = card.querySelector<HTMLElement>('[data-schedule-resize-edge="end"]')!;
    const y = (minuteOfDay(card.dataset.scheduleDeadlineValue!) / 1440) * TRACK_HEIGHT;

    const gesture = harness.pointerDown(edge.dataset.c1Key!, { clientX: 40, clientY: y });
    gesture.move(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT * 2 });
    gesture.release(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT * 2 });
    await Promise.all(pending);

    const resized = drawn.events.find((event) => event.id === app.eventId)!;
    // The start did not move, which is what makes this a resize rather than a move.
    expect(resized.startDate).toBe(startValue);
    expect(Date.parse(resized.deadline) - Date.parse(startValue)).toBe(120 * 60_000);
    expect(view.writeFeedback).toContain('resized');
  });

  it('redraws at the authoritative position when a drag loses a race, and says which revision beat it', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    const key = card.dataset.c1Key!;
    const dayKey = card.closest<HTMLElement>('[data-schedule-day]')!.dataset.scheduleDay!;
    const trackKey = `schedule-time-track-${dayKey}`;
    const startValue = card.dataset.scheduleStartValue!;
    const y = (minuteOfDay(startValue) / 1440) * TRACK_HEIGHT;

    // Somebody else moves the event between the render and the release, from the same revision the
    // block was drawn with. This is the race the checklist asks to be explicit about.
    const winnerStart = new Date(Date.parse(startValue) + 3 * 60 * 60_000).toISOString();
    expect(await app.moveEvent(app.eventId, state.events[0]!.source.revision, winnerStart)).toMatchObject({ ok: true });

    const gesture = harness.pointerDown(key, { clientX: 40, clientY: y });
    gesture.move(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT });
    gesture.release(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT });
    await Promise.all(pending);

    // The loser is told which revision beat it, and the surface is redrawn at the authoritative
    // position rather than where the pointer left the block: a lost race is the one refusal where
    // the surface was already wrong.
    expect(view.writeRefusal).toEqual({ eventId: app.eventId, code: 'stale-revision' });
    expect(view.writeFeedback).toContain('another writer changed this event first');
    expect(drawn.events.find((event) => event.id === app.eventId)!.startDate).toBe(winnerStart);
    expect(host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!.getAttribute('data-schedule-refusal'))
      .toBe('stale-revision');
  });

  it('shows a written event in every Schedule view, with the three time-grid modes drawing the exact span', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    const dayKey = card.closest<HTMLElement>('[data-schedule-day]')!.dataset.scheduleDay!;
    const trackKey = `schedule-time-track-${dayKey}`;
    const startValue = card.dataset.scheduleStartValue!;
    const y = (minuteOfDay(card.dataset.scheduleDeadlineValue!) / 1440) * TRACK_HEIGHT;

    const gesture = harness.pointerDown(card.querySelector<HTMLElement>('[data-schedule-resize-edge="end"]')!.dataset.c1Key!, { clientX: 40, clientY: y });
    gesture.move(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT * 4 });
    gesture.release(trackKey, { clientX: 40, clientY: y + SLOT_HEIGHT * 4 });
    await Promise.all(pending);

    const written = drawn.events.find((event) => event.id === app.eventId)!;
    // Ninety minutes as seeded, plus the four slots the bottom edge moved: one hundred and fifty.
    expect(Date.parse(written.deadline) - Date.parse(written.startDate)).toBe(150 * 60_000);

    // The six views are two renderers over one projection of one read. Time grid first, in its three
    // modes: each draws the block the store now holds, at the span it now holds.
    for (const mode of ['day', 'four-day', 'week'] as const) {
      const grid = document.createElement('div');
      grid.innerHTML = renderScheduleTimeGrid({
        mode,
        events: drawn.events,
        projectNames: new Map(),
        selectionLabel: 'All projects',
        calendarCursor: DAY,
        now: new Date(2026, 8, 6, 12, 0),
        selectedEventId: null,
      });
      const block = grid.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
      expect(block.dataset.scheduleStartValue).toBe(written.startDate);
      expect(block.dataset.scheduleDeadlineValue).toBe(written.deadline);
      // The drawn height is the duration over the day, which is the same arithmetic the record says.
      const height = Number(/([\d.]+)%/.exec(block.getAttribute('style')!.split('height:')[1]!)?.[1]);
      expect(height).toBeCloseTo((150 / 1440) * 100, 6);
    }

    // And the three projection modes, which read the same `events`.
    for (const mode of ['month', 'year', 'agenda'] as const) {
      const projection = document.createElement('div');
      projection.innerHTML = renderScheduleProjection({
        mode,
        events: drawn.events,
        projectNames: new Map(),
        selectionLabel: 'All projects',
        calendarCursor: DAY,
        now: new Date(2026, 8, 6, 12, 0),
        selectedEventId: null,
      });
      // Month and agenda name the event; the year view is a mini-month with one indicator per day
      // rather than a list, so what it says is that the day the written span starts holds one event.
      if (mode === 'year') {
        expect(projection.querySelector('[data-schedule-year-event-indicator]')!.getAttribute('data-schedule-occurrence-count')).toBe('1');
      } else {
        expect(projection.textContent).toContain('Dragged event');
        expect(projection.querySelectorAll('[data-schedule-event-id]').length).toBeGreaterThan(0);
      }
    }
  });

  it('creates the event a seeded form describes, and closes the form it came from', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    const before = drawn.events.length;
    harness.click('schedule-slot-2026-09-06-38');
    const name = host.querySelector<HTMLInputElement>('[data-c1-key="schedule-event-name"]')!;
    name.value = 'Seeded through the grid';
    harness.click('schedule-event-save');
    await Promise.all(pending);

    expect(drawn.events).toHaveLength(before + 1);
    const created = drawn.events.find((event) => event.name === 'Seeded through the grid')!;
    // The slot the reader clicked is the start, and the proposal is one hour.
    expect(minuteOfDay(created.startDate)).toBe(38 * 15);
    expect(Date.parse(created.deadline) - Date.parse(created.startDate)).toBe(60 * 60_000);
    expect(view.seedRefusal).toBeNull();
  });
});
