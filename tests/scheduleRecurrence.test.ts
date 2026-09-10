// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  bindScheduleRecurrenceInteractions,
  expandScheduleRecurringOccurrences,
  scheduleRecurringOccurrenceToken,
  type ScheduleRecurrenceScope,
  type ScheduleRecurringOccurrenceSelection,
} from '../src/browser/scheduleRecurrence.js';
import { renderScheduleTimeGrid } from '../src/browser/scheduleTimeGrid.js';
import { renderScheduleProjection } from '../src/browser/scheduleProjection.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { localCalendarDate } from '../src/browser/calendarGrid.js';
import type { CalendarEvent } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

function localInstant(year: number, monthIndex: number, day: number, hour: number, minute: number): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}

function recurringEvent(id: string, startDate: string, deadline: string, recurrence: Record<string, unknown>): CalendarEvent {
  return {
    id,
    source: sourceRef('event', id),
    name: `Recurring ${id}`,
    description: `Description ${id}`,
    projectId: null,
    createdAt: localInstant(2026, 0, 1, 0, 0),
    startDate,
    deadline,
    isCompleted: false,
    properties: { recurrence },
  };
}

describe('Schedule recurrence projection', () => {
  it('expands a bounded daily series deterministically without changing or duplicating the durable record', () => {
    const event = recurringEvent('daily', localInstant(2026, 8, 1, 9, 30), localInstant(2026, 8, 1, 10, 30), { frequency: 'daily', interval: 2, count: 5 });
    const events = [event];
    const before = JSON.stringify(events);
    const first = expandScheduleRecurringOccurrences(events, { start: localCalendarDate(2026, 8, 3), end: localCalendarDate(2026, 8, 9) });
    const second = expandScheduleRecurringOccurrences(events, { start: localCalendarDate(2026, 8, 3), end: localCalendarDate(2026, 8, 9) });
    expect(first.map((occurrence) => ({ eventId: occurrence.eventId, startDate: occurrence.startDate, deadline: occurrence.deadline }))).toEqual([
      { eventId: 'daily', startDate: localInstant(2026, 8, 3, 9, 30), deadline: localInstant(2026, 8, 3, 10, 30) },
      { eventId: 'daily', startDate: localInstant(2026, 8, 5, 9, 30), deadline: localInstant(2026, 8, 5, 10, 30) },
      { eventId: 'daily', startDate: localInstant(2026, 8, 7, 9, 30), deadline: localInstant(2026, 8, 7, 10, 30) },
    ]);
    expect(second.map((occurrence) => occurrence.occurrenceKey)).toEqual(first.map((occurrence) => occurrence.occurrenceKey));
    expect(first.every((occurrence) => occurrence.event === event)).toBe(true);
    expect(new Set(first.map((occurrence) => occurrence.eventId))).toEqual(new Set(['daily']));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('anchors monthly recurrence to the source civil day instead of drifting after a short month', () => {
    const event = recurringEvent('month-end', localInstant(2026, 0, 31, 9, 0), localInstant(2026, 0, 31, 10, 0), { frequency: 'monthly', count: 3 });
    expect(expandScheduleRecurringOccurrences([event], { start: localCalendarDate(2026, 0, 1), end: localCalendarDate(2026, 3, 1) }).map((occurrence) => occurrence.startDate)).toEqual([
      localInstant(2026, 0, 31, 9, 0), localInstant(2026, 1, 28, 9, 0), localInstant(2026, 2, 31, 9, 0),
    ]);
  });

  it('projects a recurring occurrence into Day without granting time-grid drag or resize and reaches the local scope-choice path on click', () => {
    const event = recurringEvent('standup', localInstant(2026, 8, 1, 9, 30), localInstant(2026, 8, 1, 10, 0), { frequency: 'daily', count: 10 });
    const before = JSON.stringify(event);
    const cursor = localCalendarDate(2026, 8, 6);
    const occurrence = expandScheduleRecurringOccurrences([event], { start: cursor, end: localCalendarDate(2026, 8, 7) })[0]!;
    const token = scheduleRecurringOccurrenceToken(occurrence);
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.querySelector<HTMLElement>('#root')!;
    let selected: ScheduleRecurringOccurrenceSelection | null = null;
    let scope: ScheduleRecurrenceScope | null = null;
    const rerender = () => { root.innerHTML = renderScheduleTimeGrid({ mode: 'day', events: [event], projectNames: new Map(), selectionLabel: 'All projects', calendarCursor: cursor, now: new Date(2026, 8, 6, 12, 0, 0, 0), selectedEventId: null, selectedRecurringOccurrence: selected, selectedRecurringScope: scope }); };
    bindScheduleRecurrenceInteractions(root, { openOccurrence: (next) => { selected = { ...next }; scope = null; rerender(); }, closeOccurrence: () => { selected = null; scope = null; rerender(); }, selectScope: (next) => { scope = next; rerender(); } });
    rerender();
    const harness = createInteractionHarness(root);
    const card = harness.target(`schedule-recurring-standup-${token}-2026-09-06`);
    expect(card.dataset.scheduleTimedEvent).toBeUndefined();
    expect(card.dataset.scheduleRecurringAction).toBe('open-occurrence');
    expect(card.querySelector('[data-schedule-resize-edge]')).toBeNull();
    harness.click(`schedule-recurring-standup-${token}-2026-09-06`);
    expect(harness.target('schedule-recurrence-scope-modal').dataset.scheduleEditorMode).toBe('recurrence-scope');
    expect(harness.target('schedule-recurrence-scope-modal').dataset.scheduleSelectedScope).toBe('');
    harness.click('schedule-recurrence-scope-occurrence');
    expect(harness.target('schedule-recurrence-scope-modal').dataset.scheduleSelectedScope).toBe('occurrence');
    expect(JSON.stringify(event)).toBe(before);
  });

  it('projects the same recurring source record into Month, Year and Agenda without introducing time-grid gesture semantics', () => {
    const event = recurringEvent('weekly', localInstant(2026, 8, 1, 8, 0), localInstant(2026, 8, 1, 9, 0), { frequency: 'weekly', count: 6 });
    const before = JSON.stringify(event);
    const cursor = localCalendarDate(2026, 8, 1);
    const occurrence = expandScheduleRecurringOccurrences([event], { start: localCalendarDate(2026, 8, 1), end: localCalendarDate(2026, 9, 1) }).find((candidate) => candidate.startDate === localInstant(2026, 8, 8, 8, 0))!;
    const token = scheduleRecurringOccurrenceToken(occurrence);
    document.body.innerHTML = renderScheduleProjection({ mode: 'month', events: [event], projectNames: new Map(), selectionLabel: 'All projects', calendarCursor: cursor, now: new Date(2026, 8, 6, 12, 0, 0, 0), selectedEventId: null, problems: [] });
    const monthHarness = createInteractionHarness(document);
    const monthCard = monthHarness.target(`schedule-month-recurring-weekly-${token}-2026-09-08`);
    expect(monthCard.dataset.scheduleRecurringEventId).toBe('weekly');
    expect(monthCard.dataset.scheduleTimedEvent).toBeUndefined();
    expect(document.querySelector('[data-schedule-resize-edge]')).toBeNull();
    document.body.innerHTML = renderScheduleProjection({ mode: 'year', events: [event], projectNames: new Map(), selectionLabel: 'All projects', calendarCursor: cursor, now: new Date(2026, 8, 6, 12, 0, 0, 0), selectedEventId: null, problems: [] });
    expect(document.querySelector<HTMLElement>('[data-schedule-year-event-indicator="2026-09-08"]')?.dataset.scheduleOccurrenceCount).toBe('1');
    expect(document.querySelector('[data-schedule-timed-event]')).toBeNull();
    document.body.innerHTML = renderScheduleProjection({ mode: 'agenda', events: [event], projectNames: new Map(), selectionLabel: 'All projects', calendarCursor: cursor, now: new Date(2026, 8, 6, 12, 0, 0, 0), selectedEventId: null, problems: [] });
    const agendaHarness = createInteractionHarness(document);
    expect(agendaHarness.target(`schedule-agenda-recurring-weekly-${token}-2026-09-08`).dataset.scheduleRecurringEventId).toBe('weekly');
    expect(document.querySelector('[data-schedule-resize-edge]')).toBeNull();
    expect(JSON.stringify(event)).toBe(before);
  });
});
