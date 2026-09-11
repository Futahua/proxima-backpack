// @vitest-environment happy-dom
/**
 * The recurrence scope modal, driven through its own binder into a real store.
 *
 * `tests/eventRecurrence.test.ts` asserts what the operations write. This asserts the surface half:
 * that clicking a recurring occurrence reaches the scope modal, that the chosen scope decides which
 * write happens, that an accepted write closes the modal and the calendar immediately draws the
 * occurrence where the record now says it is, and that a reader's scope choice and an agent's scope
 * request produce the same record.
 *
 * The shell's half is performed here the way `main.ts` performs it — run the sequence, close on
 * acceptance, keep what was typed on a refusal — because `main.ts` is not importable from a test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createEvent, type EventMutationDependencies } from '../src/app/eventMutations.js';
import { setRecurrenceAction, updateOccurrenceAction } from '../src/app/eventRecurrenceActions.js';
import { createProject } from '../src/app/projectMutations.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import type { EventWriteDependencies } from '../src/app/eventWriteActions.js';
import { fixedClock } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { defineCanonicalRecurrenceRule, opaqueRecurrenceSeriesIdFromRandomBytes, type OpaqueRecurrenceSeriesId } from '../src/domain/canonicalRecurrence.js';
import type { CanonicalEventRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState } from '../src/domain/types.js';
import { skipOccurrenceFromScope, updateOccurrenceFromScope } from '../src/browser/scheduleScopeWiring.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindScheduleRecurrenceInteractions,
  expandScheduleRecurringOccurrences,
  type ScheduleRecurrenceScope,
  type ScheduleRecurringOccurrenceSelection,
} from '../src/browser/scheduleRecurrence.js';
import { bindScheduleTimeGridInteractions, renderScheduleTimeGrid } from '../src/browser/scheduleTimeGrid.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:30:00+07:00';
const ANCHOR_DAY = new Date(2026, 8, 1);
const FIRST_START = new Date(2026, 8, 1, 9, 0).toISOString();
const FIRST_END = new Date(2026, 8, 1, 9, 30).toISOString();
const SECOND_START = new Date(2026, 8, 2, 9, 0).toISOString();

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

async function recurringWorld() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2100;
  const deps: EventMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const project = await createProject(deps, { name: 'Scope project' });
  if (!project.ok) throw new Error(`seeding the project failed: ${project.reason}`);
  const created = await createEvent(deps, { name: 'Standup', projectId: project.recordId, startDate: FIRST_START, deadline: FIRST_END });
  if (!created.ok) throw new Error(`seeding the event failed: ${created.reason}`);

  const source = recordStoreStateSource(store);
  let state = (await source.load()).state;

  const dependencies = (): EventWriteDependencies => ({
    state,
    writes: async () => ({
      createEvent: async () => { throw new Error('not used here'); },
      updateEvent: async (input) => await (await import('../src/app/eventMutations.js')).updateEvent(deps, input),
      deleteEvent: async (input) => await (await import('../src/app/eventMutations.js')).deleteEvent(deps, input),
      rescheduleEvent: async (input) => await (await import('../src/app/eventMutations.js')).rescheduleEvent(deps, input),
      resizeEvent: async (input) => await (await import('../src/app/eventMutations.js')).resizeEvent(deps, input),
    }),
    unavailableReason: () => null,
    refresh: async () => null,
    setRefusal: () => undefined,
    render: () => undefined,
  });

  await setRecurrenceAction(dependencies(), {
    eventId: created.recordId,
    rule: defineCanonicalRecurrenceRule({ frequency: 'daily', interval: 1, end: { kind: 'never' } }),
    allocateSeriesId: () => seriesIdFromLastByte(71),
  });
  state = (await source.load()).state;

  return {
    eventId: created.recordId,
    current: () => state,
    sync: async () => { state = (await source.load()).state; return state; },
    dependencies,
    event: () => state.events.find((event) => event.id === created.recordId)!,
    series: async () => {
      const observation = await store.read(created.recordId);
      return observation?.kind === 'event' ? (observation.record as CanonicalEventRecordV2).recurrence : null;
    },
  };
}

/** The occurrences the calendar draws, which is what "reprojects" is measured against. */
function occurrences(state: ProximaState, days = 4): string[] {
  const start = new Date(2026, 8, 1).getTime();
  return expandScheduleRecurringOccurrences(state.events, {
    start: new Date(start - 3_600_000),
    end: new Date(start + days * 86_400_000),
  }).map((occurrence) => occurrence.startDate);
}

interface View {
  feedback: string | null;
  refusal: string | null;
}

/** The surface: the grid plus its scope modal, bound the way the shell binds them. */
function mountScope(
  app: Awaited<ReturnType<typeof recurringWorld>>,
  view: View,
  pending: Promise<void>[],
  onState: (next: ProximaState) => void,
): { host: HTMLElement; harness: ReturnType<typeof createInteractionHarness> } {
  const host = document.createElement('div');
  document.body.append(host);
  let occurrence: ScheduleRecurringOccurrenceSelection | null = null;
  let scope: ScheduleRecurrenceScope | null = null;
  let draft: { startDate: string; deadline: string } | null = null;

  const draw = (state: ProximaState): void => {
    // A week, so the case can skip one occurrence and still have the others on screen: in Day the
    // only card would be the one it just skipped.
    host.innerHTML = renderScheduleTimeGrid({
      mode: 'week',
      events: state.events,
      projectNames: new Map(),
      selectionLabel: 'All projects',
      calendarCursor: ANCHOR_DAY,
      now: new Date(2026, 8, 1, 12, 0),
      selectedEventId: null,
      selectedRecurringOccurrence: occurrence,
      selectedRecurringScope: scope,
      recurrenceScopeWrites: { refusal: null, feedback: view.feedback, feedbackRefusal: view.refusal },
      occurrenceDraft: draft,
    });
  };
  const rerender = (): void => { draw(app.current()); };
  draw(app.current());

  bindScheduleTimeGridInteractions(host, {
    openEvent: () => undefined,
    closeEvent: () => undefined,
    seedEvent: () => undefined,
    createEvent: () => undefined,
    changeEvent: () => undefined,
    saveEvent: () => undefined,
    deleteEvent: () => undefined,
  });
  bindScheduleRecurrenceInteractions(host, {
    openOccurrence: (selection) => { occurrence = { ...selection }; scope = null; draft = null; view.feedback = null; view.refusal = null; rerender(); },
    closeOccurrence: () => { occurrence = null; scope = null; draft = null; rerender(); },
    selectScope: (next) => { scope = next; draft = null; rerender(); },
    saveOccurrence: ({ eventId, occurrenceStart, scope: chosen, startDate, deadline }) => {
      pending.push((async () => {
        const outcome = await updateOccurrenceFromScope({
          eventId,
          occurrenceStart,
          scope: chosen,
          change: { kind: 'reschedule', startDate, deadline },
          deps: app.dependencies(),
        });
        view.refusal = outcome.ok ? null : outcome.reason;
        view.feedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        // An accepted write closes the modal and clears the occurrence it was about; a refused one
        // keeps both, with the dates that were typed (D58).
        if (outcome.ok) { occurrence = null; scope = null; draft = null; }
        else draft = { startDate, deadline };
        onState(await app.sync());
        rerender();
      })());
    },
    skipOccurrence: ({ eventId, occurrenceStart }) => {
      pending.push((async () => {
        const outcome = await skipOccurrenceFromScope({ eventId, occurrenceStart, deps: app.dependencies() });
        view.refusal = outcome.ok ? null : outcome.reason;
        view.feedback = outcome.ok ? `${outcome.outcome} at revision ${outcome.revision}` : `${outcome.reason}: ${outcome.detail}`;
        if (outcome.ok) { occurrence = null; scope = null; draft = null; }
        onState(await app.sync());
        rerender();
      })());
    },
  });

  return { host, harness: createInteractionHarness(host) };
}

/** The recurring card the reader would click, by machine key. */
function firstOccurrenceKey(host: HTMLElement): string {
  const cards = Array.from(host.querySelectorAll<HTMLElement>('[data-schedule-recurring-action="open-occurrence"]'));
  if (cards.length === 0) throw new Error('no recurring occurrence was drawn');
  return cards[0]!.getAttribute('data-c1-key')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 13 the scope modal, driven through its binder', () => {
  it('asks for the scope, and an occurrence-scoped save writes one exception the calendar then draws', async () => {
    const app = await recurringWorld();
    const view: View = { feedback: null, refusal: null };
    const pending: Promise<void>[] = [];
    const { host, harness } = mountScope(app, view, pending, () => undefined);

    // A generated occurrence carries no time-grid gesture: it is not a record to drag.
    const cards = Array.from(host.querySelectorAll<HTMLElement>('[data-schedule-recurring-action="open-occurrence"]'));
    expect(cards[0]!.dataset.scheduleTimedEvent).toBeUndefined();
    harness.click(firstOccurrenceKey(host));

    const modal = harness.target('schedule-recurrence-scope-modal');
    expect(modal.dataset.scheduleEditorMode).toBe('recurrence-scope');
    expect(modal.dataset.scheduleRecurrenceWrites).toBe('available');
    expect(modal.dataset.scheduleSelectedScope).toBe('');
    // Without a scope there is no write to make, so Save is not offered as one.
    expect((harness.target('schedule-recurrence-scope-save') as HTMLButtonElement).disabled).toBe(true);

    harness.click('schedule-recurrence-scope-occurrence');
    // The modal is re-rendered on every scope change, so the assertion re-queries it rather than
    // holding a node the last render detached.
    expect(harness.target('schedule-recurrence-scope-modal').dataset.scheduleSelectedScope).toBe('occurrence');
    expect((harness.target('schedule-recurrence-scope-save') as HTMLButtonElement).disabled).toBe(false);

    // The reader's edit is the dates; the scope says which write carries them.
    const movedStart = new Date(Date.parse(FIRST_START) + 3 * 60 * 60_000).toISOString();
    const movedEnd = new Date(Date.parse(FIRST_END) + 3 * 60 * 60_000).toISOString();
    (harness.target('schedule-recurrence-occurrence-start') as HTMLInputElement).value = movedStart;
    (harness.target('schedule-recurrence-occurrence-end') as HTMLInputElement).value = movedEnd;
    harness.click('schedule-recurrence-scope-save');
    await Promise.all(pending);

    expect((await app.series())!.exceptions).toEqual([{
      occurrence: { seriesId: seriesIdFromLastByte(71), scheduledStart: FIRST_START },
      state: 'rescheduled',
      startDate: movedStart,
      deadline: movedEnd,
    }]);
    // The modal is gone, because the occurrence is no longer where the reader was looking.
    expect(host.querySelector('[data-schedule-editor-mode="recurrence-scope"]')).toBeNull();
    // And the calendar immediately draws it where the record says: the same slots, with that one
    // occurrence moved and the others untouched.
    expect(occurrences(app.current())).toEqual([movedStart, SECOND_START, new Date(2026, 8, 3, 9, 0).toISOString(), new Date(2026, 8, 4, 9, 0).toISOString()]);
    expect(view.refusal).toBeNull();
  });

  it('skips one occurrence without deleting the series, and a series-scoped save moves every occurrence', async () => {
    const app = await recurringWorld();
    const view: View = { feedback: null, refusal: null };
    const pending: Promise<void>[] = [];
    const { host, harness } = mountScope(app, view, pending, () => undefined);

    const before = occurrences(app.current());
    harness.click(firstOccurrenceKey(host));
    harness.click('schedule-recurrence-scope-skip');
    await Promise.all(pending);

    // The skipped slot is a hole: the record is still there, the other occurrences are where they
    // were, and the series says the occurrence was cancelled rather than that it never existed.
    expect(app.current().events.some((event) => event.id === app.eventId)).toBe(true);
    expect((await app.series())!.exceptions).toEqual([{
      occurrence: { seriesId: seriesIdFromLastByte(71), scheduledStart: FIRST_START },
      state: 'cancelled',
    }]);
    expect(occurrences(app.current())).toEqual(before.slice(1));

    // The other scope is a different write: the owner record moves, so every occurrence follows.
    const seriesStart = new Date(2026, 8, 10, 11, 0).toISOString();
    const seriesEnd = new Date(2026, 8, 10, 11, 30).toISOString();
    harness.click(firstOccurrenceKey(host));
    harness.click('schedule-recurrence-scope-series');
    (harness.target('schedule-recurrence-occurrence-start') as HTMLInputElement).value = seriesStart;
    (harness.target('schedule-recurrence-occurrence-end') as HTMLInputElement).value = seriesEnd;
    harness.click('schedule-recurrence-scope-save');
    await Promise.all(pending);

    expect(app.event().startDate).toBe(seriesStart);
    // The overrides described the old schedule, so they are gone rather than left dangling.
    expect((await app.series())!.exceptions).toEqual([]);
    // A longer window, because the series moved three weeks on: the point is that every occurrence
    // followed it rather than only the one the reader had opened.
    expect(occurrences(app.current(), 20).slice(0, 3)).toEqual([
      seriesStart,
      new Date(2026, 8, 11, 11, 0).toISOString(),
      new Date(2026, 8, 12, 11, 0).toISOString(),
    ]);
  });

  it('produces the same record whether the scope came from the reader or from a direct request', async () => {
    // Two identical worlds: one edited through the modal, one by the same request submitted directly,
    // which is the shape an agent uses. The scope is explicit in both, so the states must agree.
    const viaUi = await recurringWorld();
    const viaAgent = await recurringWorld();
    const movedStart = new Date(Date.parse(FIRST_START) + 90 * 60_000).toISOString();
    const movedEnd = new Date(Date.parse(FIRST_END) + 90 * 60_000).toISOString();

    const view: View = { feedback: null, refusal: null };
    const pending: Promise<void>[] = [];
    const { harness } = mountScope(viaUi, view, pending, () => undefined);
    harness.click(firstOccurrenceKey(document.body));
    harness.click('schedule-recurrence-scope-occurrence');
    (harness.target('schedule-recurrence-occurrence-start') as HTMLInputElement).value = movedStart;
    (harness.target('schedule-recurrence-occurrence-end') as HTMLInputElement).value = movedEnd;
    harness.click('schedule-recurrence-scope-save');
    await Promise.all(pending);

    const direct = await updateOccurrenceAction(viaAgent.dependencies(), {
      eventId: viaAgent.eventId,
      occurrenceStart: FIRST_START,
      scope: 'occurrence',
      change: { kind: 'reschedule', startDate: movedStart, deadline: movedEnd },
    });
    expect(direct).toMatchObject({ ok: true, scope: 'occurrence' });
    await viaAgent.sync();

    expect((await viaUi.series())!.exceptions).toEqual((await viaAgent.series())!.exceptions);
    expect(occurrences(viaUi.current())).toEqual(occurrences(viaAgent.current()));
  });
});
