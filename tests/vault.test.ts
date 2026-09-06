import { describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { elasticBoard, eventsByDay, reconcileSelection } from '../src/domain/selectors.js';
import { localDateKey } from '../src/domain/time.js';
import { DEFAULT_STATUSES } from '../src/domain/elastic.js';
import { fixtureVault, sourceRef } from './fixtures.js';

const vault = fixtureVault('vault-basic');

// The frontmatter subset and its failure modes have their own suite:
// tests/frontmatter.test.ts.

describe('loadVaultState over the real fixture vault', () => {
  it('loads every project, task and event with no problems', async () => {
    const { state, problems } = await loadVaultState(vault);
    expect(problems).toEqual([]);
    expect(state.projects).toHaveLength(3);
    expect(state.tasks).toHaveLength(7);
    expect(state.events).toHaveLength(3);
  });

  it('falls back to the filename — not the path — for a record with no id', async () => {
    const { state } = await loadVaultState(vault);
    const loose = state.tasks.find((t) => t.name === 'Untitled loose task');
    expect(loose?.id).toBe('Untitled loose task');
    expect(loose?.source.path).toBe('Proxima/tasks/Untitled loose task.md');
    expect(loose?.source.idOrigin).toBe('filename');
  });

  it('reads the elastic fields the board depends on', async () => {
    const { state } = await loadVaultState(vault);
    const standup = state.tasks.find((t) => t.id === 'task-standup');
    expect(standup?.isFixedDuration).toBe(true);
    expect(standup?.fixedDuration).toBe(15);
    expect(state.tasks.find((t) => t.id === 'task-inking')?.maxDuration).toBe(90);
  });

  it('sorts loaded tasks into the three board columns', async () => {
    const { state } = await loadVaultState(vault);
    const board = elasticBoard(state.tasks, DEFAULT_STATUSES);
    expect(board.backlog.map((t) => t.id)).toEqual(['task-colour']);
    expect(board.finished.map((t) => t.id)).toEqual(['task-layout']);
    expect(board.running).toHaveLength(5);
  });

  it('records a revision per file so an external edit is detectable', async () => {
    const first = await loadVaultState(vault);
    vault.set('Proxima/tasks/Daily standup.md', '---\nid: task-standup\nname: Changed\n---\n');
    const second = await loadVaultState(vault);
    expect(second.revisions['Proxima/tasks/Daily standup.md']).not.toBe(
      first.revisions['Proxima/tasks/Daily standup.md'],
    );
  });
});

describe('calendar and selection', () => {
  it('places a multi-day event on every local day it covers', () => {
    const byDay = eventsByDay([
      {
        id: 'e',
        source: sourceRef('event', 'e'),
        name: 'Studio week',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-09-14T09:00:00.000Z',
        deadline: '2026-09-18T17:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    // Day coverage is local-calendar, so the count depends on the viewer's zone.
    // Assert the boundaries rather than a number that only holds in one timezone.
    const first = localDateKey('2026-09-14T09:00:00.000Z');
    const last = localDateKey('2026-09-18T17:00:00.000Z');
    const keys = [...byDay.keys()].sort();
    expect(keys[0]).toBe(first);
    expect(keys[keys.length - 1]).toBe(last);
    expect(byDay.get(first)).toHaveLength(1);
    expect(byDay.get(last)).toHaveLength(1);
  });

  it('drops a schedule project when the board asks for it', async () => {
    const { state } = await loadVaultState(vault);
    expect(reconcileSelection(state.projects, 'proj-term', 'board')).toBe('all');
    expect(reconcileSelection(state.projects, 'proj-term', 'calendar')).toBe('proj-term');
    expect(reconcileSelection(state.projects, 'proj-studio', 'board')).toBe('proj-studio');
  });

  it('covers month and year boundaries with inclusive local days', () => {
    const month = eventsByDay([
      {
        id: 'month',
        source: sourceRef('event', 'month'),
        name: 'Month boundary',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-01-31T12:00:00.000Z',
        deadline: '2026-02-02T12:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect([...month.keys()]).toHaveLength(3);

    const year = eventsByDay([
      {
        id: 'year',
        source: sourceRef('event', 'year'),
        name: 'Year boundary',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-12-31T12:00:00.000Z',
        deadline: '2027-01-02T12:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect([...year.keys()]).toHaveLength(3);
  });

  it('keeps reversed events on their start day and skips invalid starts', () => {
    const startDate = '2026-04-10T09:00:00.000Z';
    const byDay = eventsByDay([
      {
        id: 'reversed',
        source: sourceRef('event', 'reversed'),
        name: 'Reversed',
        description: '',
        projectId: null,
        createdAt: '',
        startDate,
        deadline: '2026-04-08T09:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
      {
        id: 'invalid',
        source: sourceRef('event', 'invalid'),
        name: 'Invalid',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: 'not-a-date',
        deadline: '2026-04-11T09:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect([...byDay.keys()]).toEqual([localDateKey(startDate)]);
    expect(byDay.get(localDateKey(startDate))?.map((event) => event.id)).toEqual(['reversed']);
  });

  it('does not place undated or deadline-only events, but start-only is one day', () => {
    const byDay = eventsByDay([
      {
        id: 'undated',
        source: sourceRef('event', 'undated'),
        name: 'Undated',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '',
        deadline: '',
        isCompleted: false,
        properties: {},
      },
      {
        id: 'deadline-only',
        source: sourceRef('event', 'deadline-only'),
        name: 'Deadline only',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '',
        deadline: '2026-04-12T09:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
      {
        id: 'start-only',
        source: sourceRef('event', 'start-only'),
        name: 'Start only',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-04-13T09:00:00.000Z',
        deadline: '',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect([...byDay.keys()]).toEqual([localDateKey('2026-04-13T09:00:00.000Z')]);
    expect(byDay.get(localDateKey('2026-04-13T09:00:00.000Z'))?.map((event) => event.id)).toEqual([
      'start-only',
    ]);
  });

  it('keeps day coverage stable across a DST-window-shaped range', () => {
    const byDay = eventsByDay([
      {
        id: 'dst',
        source: sourceRef('event', 'dst'),
        name: 'DST range',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-03-08T12:00:00.000Z',
        deadline: '2026-03-10T12:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect([...byDay.values()].every((events) => events[0]?.id === 'dst')).toBe(true);
    expect([...byDay.keys()]).toHaveLength(3);
  });

  it('does not silently truncate a long multi-year event', () => {
    const byDay = eventsByDay([
      {
        id: 'long',
        source: sourceRef('event', 'long'),
        name: 'Long event',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2010-01-01T12:00:00.000Z',
        deadline: '2021-01-01T12:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    expect(byDay.has(localDateKey('2021-01-01T12:00:00.000Z'))).toBe(true);
  });
});
