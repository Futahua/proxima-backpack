import { describe, expect, it } from 'vitest';
import { eventsByDay, eventsForSelection, projectsFor, reconcileSelection, ALL_PROJECTS, UNCATEGORISED } from '../src/domain/selectors.js';
import { MAX_CALENDAR_EVENT_DAYS } from '../src/domain/selectors.js';
import type { CalendarEvent } from '../src/domain/types.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles, fixtureVault, sourceRef } from './fixtures.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { localDateKey } from '../src/domain/time.js';

function event(id: string, projectId: string | null, startDate: string, deadline = ''): CalendarEvent {
  return { id, source: sourceRef('event', id), name: id, description: '', projectId, createdAt: startDate, startDate, deadline, isCompleted: false, properties: {} };
}

describe('Gate 6.3A Calendar derivation', () => {
  it('filters events by active project association without a legacy project-type silo', async () => {
    const { state } = await loadVaultState(fixtureVault('vault-basic'));
    const schedule = state.projects.find((project) => project.projectType === 'schedule' && project.status === 'active')!;
    const taskProject = state.projects.find((project) => project.projectType === 'task' && project.status === 'active')!;
    const archivedSchedule = { ...schedule, id: 'archived-schedule', status: 'archived' as const };
    const sourceEvents = [event('schedule', schedule.id, '2026-09-07T09:00:00.000Z'), event('task-project', taskProject.id, '2026-09-07T09:00:00.000Z'), event('uncategorised', null, '2026-09-07T09:00:00.000Z'), event('archived', archivedSchedule.id, '2026-09-07T09:00:00.000Z')];
    const scheduleIds = new Set(projectsFor([...state.projects, archivedSchedule], 'schedule').map((project) => project.id));
    const eligible = sourceEvents.filter((item) => item.projectId === null || scheduleIds.has(item.projectId));
    expect(eligible.map((item) => item.id)).toEqual(['schedule', 'task-project', 'uncategorised']);
    expect(eventsForSelection(eligible, ALL_PROJECTS).map((item) => item.id)).toEqual(['schedule', 'task-project', 'uncategorised']);
    expect(eventsForSelection(eligible, UNCATEGORISED).map((item) => item.id)).toEqual(['uncategorised']);
    expect(eventsForSelection(eligible, schedule.id).map((item) => item.id)).toEqual(['schedule']);
    expect(eventsForSelection(eligible, taskProject.id).map((item) => item.id)).toEqual(['task-project']);
    expect(reconcileSelection(state.projects, taskProject.id, 'calendar')).toBe(taskProject.id);
    expect(reconcileSelection([...state.projects, archivedSchedule], archivedSchedule.id, 'calendar')).toBe(ALL_PROJECTS);
  });

  it('buckets single-day, inclusive multi-day, reversed, and invalid-end events safely', () => {
    const problems: never[] = [];
    const single = eventsByDay([event('single', null, '2026-09-07T09:00:00.000Z')], problems);
    expect(single.size).toBe(1);
    const multi = eventsByDay([event('multi', null, '2026-09-07T12:00:00.000Z', '2026-09-09T12:00:00.000Z')], problems);
    expect([...multi.keys()]).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
    const reversed = eventsByDay([event('reversed', null, '2026-09-07T12:00:00.000Z', '2026-09-06T12:00:00.000Z')], problems);
    expect([...reversed.keys()]).toEqual(['2026-09-07']);
    const invalidEnd = eventsByDay([event('invalid-end', null, '2026-09-07T12:00:00.000Z', 'not-a-date')], problems);
    expect([...invalidEnd.keys()]).toEqual(['2026-09-07']);
  });

  it('accepts exactly the calendar span bound and rejects one day beyond it', () => {
    const start = new Date('2026-01-01T09:00:00.000Z');
    const withinEnd = new Date(start);
    withinEnd.setDate(withinEnd.getDate() + MAX_CALENDAR_EVENT_DAYS - 1);
    const withinProblems: never[] = [];
    expect(eventsByDay([event('within', null, start.toISOString(), withinEnd.toISOString())], withinProblems).size).toBe(MAX_CALENDAR_EVENT_DAYS);
    const beyondEnd = new Date(withinEnd);
    beyondEnd.setDate(beyondEnd.getDate() + 1);
    const beyondProblems: Array<{ code: string }> = [];
    expect(eventsByDay([event('beyond', null, start.toISOString(), beyondEnd.toISOString())], beyondProblems as never)).toEqual(new Map());
    expect(beyondProblems.map((problem) => problem.code)).toEqual(['event-span-too-large']);
  });

  it('keeps date-only values on their civil date and surfaces invalid starts', async () => {
    expect(localDateKey('2026-09-07')).toBe('2026-09-07');
    expect([...eventsByDay([event('civil', null, '2026-09-07')]).keys()]).toEqual(['2026-09-07']);
    expect([...eventsByDay([event('civil-range', null, '2026-09-07', '2026-09-09')]).keys()]).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
    const files = fixtureFiles('vault-basic');
    const snapshotPath = 'Proxima/events/Vault snapshot.md';
    files[snapshotPath] = files[snapshotPath]!.replace('startDate: 2026-09-06T21:00:00.000Z', 'startDate: 2026-02-31');
    const loaded = await loadVaultState(createMemoryVault(files));
    const invalid = loaded.state.events.find((item) => item.id === 'evt-snapshot');
    expect(invalid?.startDate).toBe('');
    expect(loaded.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'bad-date', kind: 'event', id: 'evt-snapshot' })]));
    expect(eventsByDay([invalid!])).toEqual(new Map());
  });

  it('does not advance beyond the four-digit civil-date ceiling', () => {
    const problems: Array<{ code: string }> = [];
    expect([...eventsByDay([event('ceiling', null, '9999-12-31')], problems as never).keys()]).toEqual(['9999-12-31']);
    const twoDays = eventsByDay([event('ceiling-range', null, '9999-12-30', '9999-12-31')], problems as never);
    expect([...twoDays.keys()]).toEqual(['9999-12-30', '9999-12-31']);
    expect(problems).toEqual([]);
  });
});
