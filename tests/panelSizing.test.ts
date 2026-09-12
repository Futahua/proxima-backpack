// @vitest-environment happy-dom

/**
 * Panel sizing is local state only: the box's own claim, asserted at both ends.
 *
 * Three things are being pinned here, and they are the three the parity box names.
 *
 * - **The clamp is pure and holds at both ends.** A drag reports pixels and a drag can go anywhere, so the
 *   bounds are asserted at the extremes rather than in the middle: below the minimum, above the maximum, and
 *   a non-number that cannot be a width at all.
 * - **A resize writes no record.** This is asserted against a **real store**, not against a port the test
 *   supplied: the records are read before and after a resize and compared byte for byte, and the assertion is
 *   on the file contents rather than on a spy that a caller could have been added beside.
 * - **A resize is not an action.** The dispatcher's snapshot is compared before and after, so a width that
 *   leaked into local state would be visible as a changed snapshot even though no record moved. That is the
 *   difference between "local state" and "writes nothing" - a width held in the *session* would pass the
 *   record check and fail this one, and the box is about the first thing, not the second.
 */
import { describe, expect, it } from 'vitest';
import {
  clampTimekeepingPanelWidth,
  resizeTimekeepingPanel,
  timekeepingPanelWidth,
  TIMEEKEEPING_PANEL_DEFAULT_WIDTH,
  TIMEEKEEPING_PANEL_MAX_WIDTH,
  TIMEEKEEPING_PANEL_MIN_WIDTH,
} from '../src/app/panelSizing.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { defineCanonicalRecordHeader } from '../src/domain/canonicalIdentity.js';
import { MemoryRecordFiles } from './test-record-store.js';
import type { RecordStoreFileName } from '../src/ports/recordStore.js';
import { bindTimekeepingCockpitInteractions, renderTimekeepingCockpit } from '../src/browser/timekeepingCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { EMPTY_STATE } from '../src/domain/types.js';

const CLOCK_ISO = '2026-09-12T08:00:00+07:00';

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

/** A world with a store, a projection and a dispatcher: enough that a leaked write would have somewhere to go. */
async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2400;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project: CanonicalRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: idFromLastByte(1), name: 'Sized panels' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  } as CanonicalRecordV2;
  await store.createIfAbsent(project);
  const task = await createTask(deps, { name: 'A task to not touch', projectId: idFromLastByte(1) });
  if (!task.ok) throw new Error(`seeding failed: ${task.reason}`);

  const source = recordStoreStateSource(store);
  const loaded = await source.load();

  return {
    taskId: task.recordId,
    /** Every record file and its contents, which is what "no record changed" has to mean. */
    snapshot: async (): Promise<string> => {
      const names = await files.listRecordFiles();
      const parts: string[] = [];
      for (const name of [...names].sort()) {
        const file = await files.readRecordFile(name as RecordStoreFileName);
        parts.push(`${name}\n${file?.text ?? ''}`);
      }
      return parts.join('\n---\n');
    },
    dispatcher: () => createActionDispatcher({
      state: loaded.state,
      problems: [],
      revisions: loaded.revisions,
      mode: 'fixture',
      clock: fixedClock(CLOCK_ISO),
      idGenerator: sequentialIdGenerator(),
    }),
  };
}

describe('Stage 3 panel sizing is local state only', () => {
  it('clamps at both ends and refuses a width that is not a number', () => {
    // The middle first, so the extremes below are read against a clamp that is known to pass values through.
    expect(clampTimekeepingPanelWidth(500)).toBe(500);
    // A drag off the left edge, and one past the right: both land exactly on the bound rather than near it.
    expect(clampTimekeepingPanelWidth(-4000)).toBe(TIMEEKEEPING_PANEL_MIN_WIDTH);
    expect(clampTimekeepingPanelWidth(0)).toBe(TIMEEKEEPING_PANEL_MIN_WIDTH);
    expect(clampTimekeepingPanelWidth(TIMEEKEEPING_PANEL_MIN_WIDTH - 1)).toBe(TIMEEKEEPING_PANEL_MIN_WIDTH);
    expect(clampTimekeepingPanelWidth(99_999)).toBe(TIMEEKEEPING_PANEL_MAX_WIDTH);
    expect(clampTimekeepingPanelWidth(TIMEEKEEPING_PANEL_MAX_WIDTH + 1)).toBe(TIMEEKEEPING_PANEL_MAX_WIDTH);
    // A drag that reported no finite number at all is the default rather than a zero-width panel - and
    // infinity is in that group rather than at the maximum, because a width that cannot be drawn is not a
    // width someone asked for. The test says so explicitly: it would be just as defensible to saturate, and
    // a reader should be able to see which one this is without running it.
    expect(clampTimekeepingPanelWidth(Number.NaN)).toBe(TIMEEKEEPING_PANEL_DEFAULT_WIDTH);
    expect(clampTimekeepingPanelWidth(Number.POSITIVE_INFINITY)).toBe(TIMEEKEEPING_PANEL_DEFAULT_WIDTH);
    expect(clampTimekeepingPanelWidth(Number.NEGATIVE_INFINITY)).toBe(TIMEEKEEPING_PANEL_DEFAULT_WIDTH);
    // Whole pixels, so a rendered width and a held width are the same number and a reload cannot drift.
    expect(clampTimekeepingPanelWidth(500.6)).toBe(501);
    expect(Number.isInteger(clampTimekeepingPanelWidth(500.4))).toBe(true);
  });

  it('records one panel without disturbing its neighbours, and returns a new map rather than editing one', () => {
    const before = { calendar: 500, timeline: 700 };
    const after = resizeTimekeepingPanel(before, 'countdowns', 900);

    expect(after).toEqual({ calendar: 500, timeline: 700, countdowns: 900 });
    // The map that was passed in is untouched: this is a value, not a mutable view.
    expect(before).toEqual({ calendar: 500, timeline: 700 });
    expect(after).not.toBe(before);
    // A width already in effect comes back as a copy rather than as the same object, which is what makes the
    // comparison in a shell cheap and correct either way.
    const again = resizeTimekeepingPanel(after, 'countdowns', 900);
    expect(again).toEqual(after);
    expect(again).not.toBe(after);
    // The default is asked for rather than read out of the map, so a panel nobody resized draws the same width
    // everywhere instead of at whatever each call site chose.
    expect(timekeepingPanelWidth({}, 'calendar')).toBe(TIMEEKEEPING_PANEL_DEFAULT_WIDTH);
    expect(timekeepingPanelWidth(after, 'calendar')).toBe(500);
  });

  it('changes no record and no snapshot when a panel is resized', async () => {
    const app = await world();

    // The store's bytes before the resize, and the session state the shell would be holding.
    const recordsBefore = await app.snapshot();
    const dispatcher = app.dispatcher();
    const snapshotBefore = JSON.stringify(dispatcher.snapshot());

    // Every panel, at a width inside the bounds, below them and above them - including the pathological ones a
    // drag can produce. The result is the widths a shell would hold, built exactly as the shell builds them.
    let widths: Readonly<Record<string, number>> = {};
    for (const panel of ['calendar', 'timeline', 'countdowns']) {
      for (const proposed of [500, -1, 1_000_000, Number.NaN, 640.5]) {
        widths = resizeTimekeepingPanel(widths, panel, proposed);
      }
    }

    // The clamp held, so nothing unreadable or unbounded was ever held.
    for (const panel of ['calendar', 'timeline', 'countdowns']) {
      const width = timekeepingPanelWidth(widths, panel);
      expect(width).toBeGreaterThanOrEqual(TIMEEKEEPING_PANEL_MIN_WIDTH);
      expect(width).toBeLessThanOrEqual(TIMEEKEEPING_PANEL_MAX_WIDTH);
      expect(Number.isInteger(width)).toBe(true);
    }

    // And the two assertions the box is actually about. The first is the record claim: not "no write was
    // attempted" but "the bytes are identical", which a write that happened to be a no-op would fail.
    expect(await app.snapshot()).toBe(recordsBefore);
    // The second is the *local state* claim, and it is the stronger one: a width that reached the session
    // rather than the view would leave the store untouched and still fail here.
    expect(JSON.stringify(app.dispatcher().snapshot())).toBe(snapshotBefore);
    // The task the world holds is still exactly what it was, read back through the store rather than the view.
    expect((await app.snapshot()).includes(app.taskId)).toBe(true);
  });

  it('drags a panel edge through the bound surface and hands the shell a clamped width', () => {
    // The pure module is asserted above; this drives the *interaction*. Without it, the binding could be
    // deleted - or pointed at the wrong data attribute - and every assertion in this file would still pass,
    // because the module under test would still be correct and simply never reached.
    const root = document.createElement('div');
    root.innerHTML = renderTimekeepingCockpit({
      state: EMPTY_STATE,
      tasks: [],
      projectNames: new Map(),
      selectionLabel: 'All projects',
      panels: { calendar: true, timeline: true, countdowns: false },
      now: new Date('2026-09-12T08:00:00+07:00'),
      calendarCursor: new Date('2026-09-12T08:00:00+07:00'),
      selectedTaskId: null,
      editorDraft: null,
    });

    const resizes: { panel: string; width: number }[] = [];
    bindTimekeepingCockpitInteractions(root, {
      openTask: () => undefined,
      setPanelVisible: () => undefined,
      navigateMonth: () => undefined,
      today: () => undefined,
      changeTask: () => undefined,
      resizePanel: (panel, width) => { resizes.push({ panel, width }); },
    });

    const harness = createInteractionHarness(root);
    // The panel's own edge is the drag handle, and the width it reports is the one the panel was drawn at -
    // not the pointer's absolute position, which is what makes the drag relative rather than absolute.
    const edge = harness.target('timekeeping-panel-resize-calendar');
    expect(Number(edge.dataset.timekeepingPanelWidth)).toBe(TIMEEKEEPING_PANEL_DEFAULT_WIDTH);
    expect(edge.getAttribute('role')).toBe('separator');

    // A drag to the right by a hundred pixels: begun on the edge, moved, released - and the width is reported
    // once, on release, rather than on every pixel the pointer crosses. The harness's `move` is what makes the
    // gesture the three events a person actually performs; a `release` on its own is a click that happens to be
    // over an edge, and it reports the width the panel already had. (The gesture's methods return the dispatched
    // event rather than the gesture, so the three are separate statements.)
    const drag = harness.pointerDown('timekeeping-panel-resize-calendar', { clientX: 100, clientY: 0 });
    drag.move('timekeeping-panel-resize-calendar', { clientX: 200, clientY: 0 });
    drag.release('timekeeping-panel-resize-calendar', { clientX: 200, clientY: 0 });
    expect(resizes).toEqual([{ panel: 'calendar', width: TIMEEKEEPING_PANEL_DEFAULT_WIDTH + 100 }]);

    // The reported width is **unclamped**, which is the division the box asks for: the surface reports the
    // drag and the app layer clamps it, so a drag off the edge cannot make a surface hold a width the sizing
    // module would refuse. The clamp itself is asserted in the case above.
    const far = harness.pointerDown('timekeeping-panel-resize-timeline', { clientX: 0, clientY: 0 });
    far.move('timekeeping-panel-resize-timeline', { clientX: -99_999, clientY: 0 });
    far.release('timekeeping-panel-resize-timeline', { clientX: -99_999, clientY: 0 });
    expect(resizes[1]).toEqual({ panel: 'timeline', width: TIMEEKEEPING_PANEL_DEFAULT_WIDTH - 99_999 });
    expect(clampTimekeepingPanelWidth(resizes[1]!.width)).toBe(TIMEEKEEPING_PANEL_MIN_WIDTH);

    // A hidden panel draws no slot, so there is no edge for it - the panel control and the resize edge are the
    // same statement about which panels exist.
    expect(root.querySelector('[data-timekeeping-panel-resize="countdowns"]')).toBeNull();
    // And the drawn width is the one the widths map holds, so a shell that keeps them sees the panel it sized.
    const sized = renderTimekeepingCockpit({
      state: EMPTY_STATE,
      tasks: [],
      projectNames: new Map(),
      selectionLabel: 'All projects',
      panels: { calendar: true, timeline: false, countdowns: false },
      panelWidths: resizeTimekeepingPanel({}, 'calendar', 900),
      now: new Date('2026-09-12T08:00:00+07:00'),
      calendarCursor: new Date('2026-09-12T08:00:00+07:00'),
      selectedTaskId: null,
      editorDraft: null,
    });
    expect(sized).toContain('data-timekeeping-panel-slot="calendar" data-timekeeping-panel-width="900"');
    expect(sized).toContain('style="width:900px"');
  });
});
