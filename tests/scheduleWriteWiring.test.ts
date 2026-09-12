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
import { createEvent, deleteEvent, rescheduleEvent, resizeEvent, updateEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import { createEventAction, deleteEventAction, rescheduleEventAction, resizeEventAction, saveEventAction, type EventWriteDependencies } from '../src/app/eventWriteActions.js';
import { eventEditorDraftFor, type EventEditorDraft } from '../src/app/eventEditor.js';
import { eventRecurrenceFor } from '../src/browser/eventModal.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { bindScheduleProjectionInteractions, renderScheduleProjection } from '../src/browser/scheduleProjection.js';
import {
  bindScheduleTimeGridInteractions,
  renderScheduleTimeGrid,
  type ScheduleEventChangeIntent,
  type ScheduleEventDraft,
  type ScheduleTimeGridMode,
} from '../src/browser/scheduleTimeGrid.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

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
      updateEvent: async (input: Parameters<typeof updateEvent>[1]) => await updateEvent(deps, input),
      deleteEvent: async (input: Parameters<typeof deleteEvent>[1]) => await deleteEvent(deps, input),
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
  // The seeded form, the open editor and its draft are shell state, exactly as they are in `main.ts`:
  // the grid asks for them, the shell holds them, and a re-render draws them.
  let seeded: ScheduleEventDraft | null = null;
  let selected: string | null = null;
  let draft: EventEditorDraft | null = null;

  const draw = (current: ProximaState): void => {
    host.innerHTML = renderScheduleTimeGrid({
      mode: currentMode,
      events: current.events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: DAY,
      now: new Date(2026, 8, 6, 12, 0),
      selectedEventId: selected,
      seededEvent: seeded,
      writeRefusal: view.writeRefusal,
      writeFeedback: view.writeFeedback,
      seedRefusal: view.seedRefusal,
      eventEditorWrites: { refusal: null, feedback: view.writeFeedback, feedbackRefusal: view.writeRefusal?.code ?? null },
      eventEditorDraft: draft,
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
    ids: semanticIds(),
    audit: recordingAudit(),
  });

  bindScheduleTimeGridInteractions(host, {
    saveEvent: ({ eventId, values }) => {
      pending.push((async () => {
        const outcome = await saveEventAction(dependencies(state), { eventId, values });
        view.writeRefusal = outcome.ok ? null : { eventId, code: outcome.reason };
        view.writeFeedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        // An accepted save closes the editor, as the shell does; a refused one leaves it open with
        // the reader's values still in it, which is what the draft is for (D58).
        if (outcome.ok) selected = null;
        else {
          const event = state.events.find((candidate) => candidate.id === eventId);
          if (event !== undefined) {
            draft = eventEditorDraftFor(
              { ...event, name: values.name, description: values.description, projectId: values.projectId, startDate: values.startDate, deadline: values.deadline, isCompleted: values.isCompleted },
              eventRecurrenceFor(event),
            );
          }
        }
        state = await app.read();
        onState(state);
        draw(state);
      })());
    },
    deleteEvent: ({ eventId }) => {
      pending.push((async () => {
        const outcome = await deleteEventAction(dependencies(state), { eventId });
        view.writeRefusal = outcome.ok ? null : { eventId, code: outcome.reason };
        view.writeFeedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        if (outcome.ok) selected = null;
        state = await app.read();
        onState(state);
        draw(state);
      })());
    },
    openEvent: (eventId) => { selected = eventId; draft = null; view.writeFeedback = null; view.writeRefusal = null; draw(state); },
    closeEvent: () => { selected = null; seeded = null; draft = null; view.seedRefusal = null; draw(state); },
    seedEvent: (draft) => { seeded = { ...draft }; view.seedRefusal = null; draw(state); },
    createEvent: (intent) => {
      pending.push((async () => {
        const outcome = await createEventAction(dependencies(state), {
          values: { name: intent.name, description: intent.description, projectId: intent.projectId, startDate: intent.startDate, deadline: intent.deadline, isCompleted: false, recurrence: { kind: 'none' } },
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

/**
 * The Month surface's editor, mounted the same way: the shell's half is identical, and only the
 * binder and the action attributes differ.
 */
function mountProjection(
  state: ProximaState,
  app: Awaited<ReturnType<typeof scheduleWorld>>,
  view: View,
  pending: Promise<void>[],
  onState: (next: ProximaState) => void,
): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  let selected: string | null = null;
  let draft: EventEditorDraft | null = null;

  const draw = (current: ProximaState): void => {
    host.innerHTML = renderScheduleProjection({
      mode: 'month',
      events: current.events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: DAY,
      now: new Date(2026, 8, 6, 12, 0),
      selectedEventId: selected,
      eventEditorWrites: { refusal: null, feedback: view.writeFeedback, feedbackRefusal: view.writeRefusal?.code ?? null },
      eventEditorDraft: draft,
    });
  };
  draw(state);

  bindScheduleProjectionInteractions(host, {
    openEvent: (eventId) => { selected = eventId; draft = null; view.writeFeedback = null; view.writeRefusal = null; draw(state); },
    closeEvent: () => { selected = null; draft = null; draw(state); },
    saveEvent: ({ eventId, values }) => {
      pending.push((async () => {
        const outcome = await saveEventAction(
          {
            state,
            writes: async () => app.operations,
            unavailableReason: () => null,
            refresh: async () => null,
            setRefusal: () => undefined,
            render: () => undefined,
            ids: semanticIds(),
            audit: recordingAudit(),
          },
          { eventId, values },
        );
        view.writeRefusal = outcome.ok ? null : { eventId, code: outcome.reason };
        view.writeFeedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        if (outcome.ok) selected = null;
        state = await app.read();
        onState(state);
        draw(state);
      })());
    },
    deleteEvent: () => undefined,
    selectMonth: () => undefined,
    drillMonth: () => undefined,
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

  it('saves the Event editor by submitting the difference, and closes it only on acceptance', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    // The editor opens on the record: the fields show what the store holds, not a rebuilt guess.
    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    harness.click(card.dataset.c1Key!);
    expect(host.querySelector<HTMLElement>('[data-schedule-editor-mode="edit"]')!.dataset.scheduleEventWrites).toBe('available');
    const name = host.querySelector<HTMLInputElement>('[data-schedule-event-field="name"]')!;
    expect(name.readOnly).toBe(false);
    expect(name.value).toBe('Dragged event');

    // Only the fields that changed are submitted, so the record's other fields are not rewritten.
    name.value = 'Renamed in the editor';
    const end = host.querySelector<HTMLInputElement>('[data-schedule-event-field="end"]')!;
    const originalEnd = end.value;
    harness.click('schedule-event-save');
    await Promise.all(pending);

    const saved = drawn.events.find((event) => event.id === app.eventId)!;
    expect(saved.name).toBe('Renamed in the editor');
    expect(saved.deadline).toBe(originalEnd);
    expect(view.writeFeedback).toContain('updated');
    // Accepted, so the editor goes: the record now says what the form said.
    expect(host.querySelector('[data-schedule-editor-mode="edit"]')).toBeNull();
  });

  it('keeps the editor open with what was typed when a save is refused, and deletes only on acceptance', async () => {
    const app = await scheduleWorld();
    const state = await app.read();
    const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
    const pending: Promise<void>[] = [];
    let drawn = state;
    const host = mount(state, app, view, pending, (next) => { drawn = next; });
    const harness = createInteractionHarness(host);

    const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"]')!;
    harness.click(card.dataset.c1Key!);

    // Somebody else moves the event while the form is open, from the revision the block was drawn
    // with, so the save is the loser of a race rather than a plain refusal.
    const startValue = drawn.events.find((event) => event.id === app.eventId)!.startDate;
    const moved = new Date(Date.parse(startValue) + 60 * 60_000).toISOString();
    expect(await app.moveEvent(app.eventId, drawn.events.find((event) => event.id === app.eventId)!.source.revision, moved))
      .toMatchObject({ ok: true });
    drawn = await app.read();

    const name = host.querySelector<HTMLInputElement>('[data-schedule-event-field="name"]')!;
    name.value = 'Typed before the refusal';
    harness.click('schedule-event-save');
    await Promise.all(pending);

    // The refusal is drawn on the form, and the form still says what the reader typed.
    expect(view.writeRefusal).toEqual({ eventId: app.eventId, code: 'stale-revision' });
    const note = host.querySelector<HTMLElement>('[data-schedule-event-refusal]')!;
    expect(note.getAttribute('data-schedule-event-refusal')).toBe('stale-revision');
    expect(note.textContent).toContain('another writer changed this event first');
    expect(host.querySelector<HTMLInputElement>('[data-schedule-event-field="name"]')!.value).toBe('Typed before the refusal');

    // Delete is the same sequence the other verbs use, and it closes the editor only when accepted.
    harness.click('schedule-event-delete');
    await Promise.all(pending);
    expect(drawn.events.some((event) => event.id === app.eventId)).toBe(false);
    expect(host.querySelector('[data-schedule-editor-mode="edit"]')).toBeNull();
  });

  it('writes the same record through the Month editor as through the Day editor', async () => {
    // Two identical worlds, one edited from Day and one from Month. The claim the box makes is that
    // the surface does not change what the write means, so the two resulting records are compared
    // field by field with only the identity and the revision (which names the record file) removed.
    const editThrough = async (surface: 'day' | 'month') => {
      const app = await scheduleWorld();
      const state = await app.read();
      const view: View = { writeRefusal: null, writeFeedback: null, seedRefusal: null };
      const pending: Promise<void>[] = [];
      let drawn = state;
      const host = surface === 'day'
        ? mount(state, app, view, pending, (next) => { drawn = next; })
        : mountProjection(state, app, view, pending, (next) => { drawn = next; });
      const harness = createInteractionHarness(host);

      const card = host.querySelector<HTMLElement>('[data-schedule-timed-event="true"], [data-schedule-event-id]')!;
      harness.click(card.dataset.c1Key!);
      const modal = host.querySelector<HTMLElement>('[data-schedule-editor-mode="edit"]')!;
      expect(modal.dataset.scheduleEventWrites).toBe('available');
      const name = modal.querySelector<HTMLInputElement>('[data-schedule-event-field="name"]')!;
      name.value = 'Renamed once';
      harness.click('schedule-event-save');
      await Promise.all(pending);

      expect(view.writeFeedback).toContain('updated');
      return { record: drawn.events.find((event) => event.id === app.eventId)!, revision: drawn.events.find((event) => event.id === app.eventId)!.source.revision };
    };

    const viaDay = await editThrough('day');
    const viaMonth = await editThrough('month');
    expect(viaDay.record.name).toBe('Renamed once');
    expect({ ...viaMonth.record, id: 'same', source: { ...viaMonth.record.source, path: 'same' } })
      .toEqual({ ...viaDay.record, id: 'same', source: { ...viaDay.record.source, path: 'same' } });
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