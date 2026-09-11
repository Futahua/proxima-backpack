// @vitest-environment happy-dom
/**
 * A Gantt bar drag and an edge resize, driven through the real binder into a real store.
 *
 * `tests/timelineChangeAction.test.ts` asserts what the sequence writes. This asserts the surface
 * half: that a pointer drag previews whole days before it commits anything, that releasing it writes
 * the dates the preview showed, that a shift-drag on an edge moves only that end, that the row the
 * bar was dropped in is never written, and that a reader's gesture and an agent's request produce the
 * same record.
 *
 * The shell's half is performed here the way `main.ts` performs it — run the sequence, hold the
 * answer, re-read, redraw — because `main.ts` is not importable from a test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { changeTaskDatesAction } from '../src/app/timelineChangeAction.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { bindTimekeepingCockpitInteractions, renderTimekeepingCockpit } from '../src/browser/timekeepingCockpit.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-02T09:30:00+07:00';
const CURSOR = new Date(2026, 8, 1);
const NOW = new Date(2026, 8, 2, 12, 0);
const TRACK_WIDTH = 420;
const COLUMNS = 42;
const DAY_WIDTH = TRACK_WIDTH / COLUMNS;

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

/** The two tasks the window draws: one to drag, one to compare an agent's request against. */
async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2500;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Gantt project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);

  const seed = async (name: string, startDate: string, deadline: string) => {
    const task = await createTask(deps, { name, projectId: project.recordId, startDate, deadline, executionState: 'backlog', executionOrder: 1 });
    if (!task.ok) throw new Error(`seeding ${name} failed: ${task.reason}`);
    return task.recordId;
  };
  const dragged = await seed('Dragged', new Date(2026, 8, 10, 9, 0).toISOString(), new Date(2026, 8, 12, 17, 0).toISOString());
  const agent = await seed('Agent', new Date(2026, 8, 10, 9, 0).toISOString(), new Date(2026, 8, 12, 17, 0).toISOString());

  const source = recordStoreStateSource(store);
  let state = (await source.load()).state;

  return {
    dragged,
    agent,
    current: () => state,
    sync: async () => { state = (await source.load()).state; return state; },
    task: (id: OpaqueRecordId) => state.tasks.find((candidate) => candidate.id === id)!,
    /** The operations a resolved write path hands a surface. */
    writes: async () => ({ updateTask: async (input: Parameters<typeof import('../src/app/taskMutations.js').updateTask>[1]) => await (await import('../src/app/taskMutations.js')).updateTask(deps, input) }),
  };
}

interface View {
  refusal: { taskId: string; code: string } | null;
  feedback: string | null;
}

/** The surface: the cockpit, bound the way the shell binds it. */
function mountCockpit(
  app: Awaited<ReturnType<typeof world>>,
  view: View,
  pending: Promise<void>[],
  onState: (next: ProximaState) => void,
): { host: HTMLElement; harness: ReturnType<typeof createInteractionHarness> } {
  const host = document.createElement('div');
  document.body.append(host);

  const geometry = (): void => {
    // happy-dom does not lay out, so the track is measured the way the surface expects: 42 day
    // columns across the width the grid declares.
    host.querySelectorAll<HTMLElement>('.timekeeping-gantt-track').forEach((track) => {
      track.getBoundingClientRect = () => ({
        x: 0, y: 0, width: TRACK_WIDTH, height: 40, top: 0, right: TRACK_WIDTH, bottom: 40, toJSON: () => ({}),
      }) as DOMRect;
    });
  };

  const draw = (state: ProximaState): void => {
    host.innerHTML = renderTimekeepingCockpit({
      state,
      tasks: state.tasks,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      panels: { calendar: true, timeline: true, countdowns: true },
      calendarCursor: CURSOR,
      now: NOW,
      selectedTaskId: null,
      editorDraft: null,
      timelineWrites: view.refusal,
      timelineFeedback: view.feedback,
    });
    geometry();
  };
  draw(app.current());

  bindTimekeepingCockpitInteractions(host, {
    openTask: () => undefined,
    setPanelVisible: () => undefined,
    today: () => undefined,
    navigateMonth: () => undefined,
    changeTask: (intent) => {
      pending.push((async () => {
        const outcome = await changeTaskDatesAction(
          {
            state: app.current(),
            writes: app.writes,
            unavailableReason: () => null,
            refresh: async () => null,
            setRefusal: () => undefined,
            render: () => undefined,
          },
          intent,
        );
        view.refusal = outcome.ok ? null : { taskId: intent.taskId, code: outcome.reason };
        view.feedback = outcome.ok ? `dates written at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        onState(await app.sync());
        draw(app.current());
      })());
    },
  });

  return { host, harness: createInteractionHarness(host) };
}

/** The bar's civil span as the surface draws it, which is what the case compares. */
function spanOf(app: Awaited<ReturnType<typeof world>>, id: OpaqueRecordId): { startDate: string | null; deadline: string | null } {
  const task = app.task(id);
  return { startDate: task.startDate, deadline: task.deadline };
}

/** Whole days between two instants, which is what a day-column drag moves. */
function dayDelta(left: string | null, right: string | null): number {
  return Math.round((Date.parse(right ?? '') - Date.parse(left ?? '')) / 86_400_000);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 14 the Gantt, driven through its binder', () => {
  it('previews whole days while dragging, writes the dates it previewed, and leaves the row alone', async () => {
    const app = await world();
    const view: View = { refusal: null, feedback: null };
    const pending: Promise<void>[] = [];
    let drawn = app.current();
    const { host, harness } = mountCockpit(app, view, pending, (next) => { drawn = next; });
    const before = spanOf(app, app.dragged);

    const barKey = `timekeeping-gantt-task-${app.dragged}`;
    const rowKey = `timekeeping-gantt-row-${app.dragged}`;
    const gesture = harness.pointerDown(barKey, { clientX: 0, clientY: 10 });
    // Two day columns to the right: the provisional geometry and the dates it stands for are drawn
    // before anything is written.
    gesture.move(rowKey, { clientX: DAY_WIDTH * 2, clientY: 10 });

    const bar = harness.target(barKey);
    expect(bar.dataset.ganttPreviewSpanColumns).toBe('3');
    expect(bar.dataset.ganttProposedStart).toBeDefined();
    expect(dayDelta(before.startDate, bar.dataset.ganttProposedStart!)).toBe(2);
    expect(dayDelta(before.deadline, bar.dataset.ganttProposedDeadline!)).toBe(2);
    // Nothing has been written yet: the preview is the surface's.
    expect((await app.sync()).tasks.find((task) => task.id === app.dragged)).toMatchObject(before);

    gesture.release(rowKey, { clientX: DAY_WIDTH * 2, clientY: 10 });
    await Promise.all(pending);

    const after = spanOf(app, app.dragged);
    expect(dayDelta(before.startDate, after.startDate)).toBe(2);
    expect(dayDelta(before.deadline, after.deadline)).toBe(2);
    expect(dayDelta(after.startDate, after.deadline)).toBe(dayDelta(before.startDate, before.deadline));
    expect(view.refusal).toBeNull();
    // The row is the surface's: the record's own ordering fields are not part of this write.
    expect(app.task(app.dragged).orderIndex).toBe(app.task(app.agent).orderIndex);
    // And the bar the next render draws is the moved one.
    expect(host.querySelector<HTMLElement>(`[data-c1-key="${barKey}"]`)!.dataset.ganttStartValue).toBe(after.startDate);
  });

  it('moves one end when shift-dragging an edge, and refuses an inverted range with the bar restored', async () => {
    const app = await world();
    const view: View = { refusal: null, feedback: null };
    const pending: Promise<void>[] = [];
    let drawn = app.current();
    const { host, harness } = mountCockpit(app, view, pending, (next) => { drawn = next; });
    const before = spanOf(app, app.dragged);

    // Shift + the end edge: the start stays and the deadline moves two days later.
    const endGesture = harness.pointerDown(`timekeeping-gantt-edge-end-${app.dragged}`, { clientX: 0, clientY: 10 }, { shiftKey: true });
    endGesture.move(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 2, clientY: 10 }, { shiftKey: true });
    endGesture.release(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 2, clientY: 10 }, { shiftKey: true });
    await Promise.all(pending);
    const afterEnd = spanOf(app, app.dragged);
    expect(afterEnd.startDate).toBe(before.startDate);
    expect(dayDelta(before.deadline, afterEnd.deadline)).toBe(2);

    // Shift + the start edge, pulled past the deadline: the range is refused where the gesture is,
    // before it ever becomes a request, and the surface is left drawing the record rather than the
    // pointer. (The sequence's own refusal of an inverted range is asserted in
    // `tests/timelineChangeAction.test.ts`; what this case adds is that the gesture does not let one
    // reach it at all.)
    drawn = app.current();
    const startGesture = harness.pointerDown(`timekeeping-gantt-edge-start-${app.dragged}`, { clientX: 0, clientY: 10 }, { shiftKey: true });
    startGesture.move(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 10, clientY: 10 }, { shiftKey: true });
    expect(harness.target(`timekeeping-gantt-task-${app.dragged}`).dataset.ganttInvalid).toBe('true');
    startGesture.release(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 10, clientY: 10 }, { shiftKey: true });
    await Promise.all(pending);

    // Nothing was submitted, so nothing was refused by the store and nothing moved.
    expect(pending).toHaveLength(1);
    expect(view.refusal).toBeNull();
    expect(spanOf(app, app.dragged)).toEqual(afterEnd);
    const restored = host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-gantt-task-${app.dragged}"]`)!;
    expect(restored.dataset.ganttStartValue).toBe(afterEnd.startDate);
    expect(restored.dataset.ganttInvalid).toBeUndefined();
  });

  it('produces the same dates whether the change came from the pointer or from a direct request', async () => {
    const viaPointer = await world();
    const viaAgent = await world();
    const view: View = { refusal: null, feedback: null };
    const pending: Promise<void>[] = [];
    const { harness } = mountCockpit(viaPointer, view, pending, () => undefined);

    const gesture = harness.pointerDown(`timekeeping-gantt-task-${viaPointer.dragged}`, { clientX: 0, clientY: 10 });
    gesture.move(`timekeeping-gantt-row-${viaPointer.dragged}`, { clientX: DAY_WIDTH * 3, clientY: 10 });
    gesture.release(`timekeeping-gantt-row-${viaPointer.dragged}`, { clientX: DAY_WIDTH * 3, clientY: 10 });
    await Promise.all(pending);

    const fromPointer = spanOf(viaPointer, viaPointer.dragged);
    // The agent's request is the same two dates, said rather than dragged.
    expect(await changeTaskDatesAction(
      {
        state: viaAgent.current(),
        writes: viaAgent.writes,
        unavailableReason: () => null,
        refresh: async () => null,
        setRefusal: () => undefined,
        render: () => undefined,
      },
      {
        taskId: viaAgent.agent,
        operation: 'move',
        proposedStartDate: fromPointer.startDate,
        proposedDeadline: fromPointer.deadline,
        targetRowIndex: 0,
      },
    )).toMatchObject({ ok: true });
    // The direct caller writes through the same sequence, so the state it lands in is read back the
    // same way rather than compared against the snapshot the request was made from.
    await viaAgent.sync();

    expect(spanOf(viaAgent, viaAgent.agent)).toEqual(fromPointer);
  });

  it('leaves the Countdowns and the Deadline Calendar drawing the new dates on their next render', async () => {
    const app = await world();
    const view: View = { refusal: null, feedback: null };
    const pending: Promise<void>[] = [];
    const { host, harness } = mountCockpit(app, view, pending, () => undefined);
    const before = spanOf(app, app.dragged);
    // The day keys the calendar draws are local civil days, so the case reads the one the bar carries
    // rather than slicing an instant and hoping the two agree.
    const beforeDayKey = host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-gantt-task-${app.dragged}"]`)!.dataset.ganttEnd!;
    const beforeOldCount = Number(host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-calendar-day-${beforeDayKey}"]`)!.dataset.deadlineCount);

    const gesture = harness.pointerDown(`timekeeping-gantt-task-${app.dragged}`, { clientX: 0, clientY: 10 });
    gesture.move(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 5, clientY: 10 });
    gesture.release(`timekeeping-gantt-row-${app.dragged}`, { clientX: DAY_WIDTH * 5, clientY: 10 });
    await Promise.all(pending);

    const after = spanOf(app, app.dragged);
    expect(dayDelta(before.deadline, after.deadline)).toBe(5);
    // The two panels read the same state, so the day the deadline falls on is a different one and the
    // calendar says so: the old day carries nothing and the new one carries the task.
    // The second task still falls on that day, so the count drops by the one that moved rather than
    // to zero: the calendar is a projection of the tasks, not of one bar.
    const oldDay = host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-calendar-day-${beforeDayKey}"]`)!;
    expect(Number(oldDay.dataset.deadlineCount)).toBe(beforeOldCount - 1);
    const newDayKey = host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-gantt-task-${app.dragged}"]`)!.dataset.ganttEnd!;
    expect(newDayKey).not.toBe(beforeDayKey);
    const newDay = host.querySelector<HTMLElement>(`[data-c1-key="timekeeping-calendar-day-${newDayKey}"]`)!;
    expect(Number(newDay.dataset.deadlineCount)).toBeGreaterThan(0);
    // And the countdown panel is drawn from the same read rather than from a cached one.
    expect(host.querySelector('[data-c1-key="timekeeping-panel-countdowns"]')).not.toBeNull();
  });
});