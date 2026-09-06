/**
 * Gate 1B — numeric and domain validation.
 *
 * The rule under test is not "bad input is rejected" but "bad input is never silently
 * substituted". Every reader below may fall back to a safe value; none may do it
 * without saying so, because a card sized from a default nobody chose looks exactly
 * like a card sized from a real number.
 */
import { describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  readBoolean,
  readDate,
  readDurationMinutes,
  readEnum,
  readOptionalDate,
  readOrderIndex,
  readStatus,
  readWeight,
  type FieldIssue,
} from '../src/domain/validation.js';
import { problemsFor } from '../src/domain/problems.js';
import {
  calculateElasticTimeline,
  elasticCardHeights,
  DEFAULT_STATUSES,
} from '../src/domain/elastic.js';
import { elasticBoard } from '../src/domain/selectors.js';
import { fixtureVault } from './fixtures.js';

const collect = () => [] as FieldIssue[];
const malformed = () => loadVaultState(fixtureVault('vault-malformed'));

describe('readWeight', () => {
  it('accepts a positive number, from a number or a numeric string', () => {
    const issues = collect();
    expect(readWeight(3, issues)).toBe(3);
    expect(readWeight('2.5', issues)).toBe(2.5);
    expect(issues).toEqual([]);
  });

  it('defaults an absent weight to 1 without complaint', () => {
    const issues = collect();
    expect(readWeight(undefined, issues)).toBe(1);
    expect(issues).toEqual([]);
  });

  it('rejects zero and negative weights, and says why', () => {
    for (const bad of [0, -3, '-0.5']) {
      const issues = collect();
      expect(readWeight(bad, issues)).toBe(1);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ field: 'weight', code: 'out-of-range' });
    }
  });

  it('rejects a weight that is not a number', () => {
    const issues = collect();
    expect(readWeight('heavy', issues)).toBe(1);
    expect(issues[0]).toMatchObject({ code: 'not-a-number' });
  });
});

describe('readOrderIndex', () => {
  it('accepts any finite number, including negative and fractional', () => {
    const issues = collect();
    expect(readOrderIndex(-2, issues)).toBe(-2);
    expect(readOrderIndex(1.5, issues)).toBe(1.5);
    expect(readOrderIndex(0, issues)).toBe(0);
    expect(issues).toEqual([]);
  });

  it('falls back to 0 and reports anything unreadable', () => {
    const issues = collect();
    expect(readOrderIndex('soon', issues)).toBe(0);
    expect(issues[0]).toMatchObject({ field: 'orderIndex', code: 'not-a-number' });
  });
});

describe('readDurationMinutes', () => {
  it('treats an absent, null or empty duration as unset, silently', () => {
    const issues = collect();
    expect(readDurationMinutes(undefined, 'fixedDuration', issues)).toBe(null);
    expect(readDurationMinutes(null, 'fixedDuration', issues)).toBe(null);
    expect(readDurationMinutes('', 'fixedDuration', issues)).toBe(null);
    expect(issues).toEqual([]);
  });

  it('accepts a positive number of minutes', () => {
    const issues = collect();
    expect(readDurationMinutes(90, 'maxDuration', issues)).toBe(90);
    expect(issues).toEqual([]);
  });

  it('rejects zero and negative durations rather than carrying them', () => {
    for (const bad of [0, -30]) {
      const issues = collect();
      expect(readDurationMinutes(bad, 'fixedDuration', issues)).toBe(null);
      expect(issues[0]).toMatchObject({ field: 'fixedDuration', code: 'out-of-range' });
    }
  });

  it('rejects a duration that is not a number', () => {
    const issues = collect();
    expect(readDurationMinutes('half an hour', 'maxDuration', issues)).toBe(null);
    expect(issues[0]).toMatchObject({ code: 'not-a-number' });
  });
});

describe('readBoolean', () => {
  it('accepts real booleans and an absent value', () => {
    const issues = collect();
    expect(readBoolean(true, 'isCompleted', false, issues)).toBe(true);
    expect(readBoolean(false, 'isCompleted', true, issues)).toBe(false);
    expect(readBoolean(undefined, 'isCompleted', false, issues)).toBe(false);
    expect(issues).toEqual([]);
  });

  it('reports a value that only looks like a boolean', () => {
    const issues = collect();
    expect(readBoolean('yes', 'isCompleted', false, issues)).toBe(false);
    expect(issues[0]).toMatchObject({ field: 'isCompleted', code: 'not-a-boolean' });
  });
});

describe('readStatus', () => {
  it('accepts any well-formed identifier, configured or not', () => {
    const issues = collect();
    expect(readStatus('running', 'running', issues)).toBe('running');
    expect(readStatus('my-own-status', 'running', issues)).toBe('my-own-status');
    expect(readStatus('  spaced  ', 'running', issues)).toBe('spaced');
    expect(issues).toEqual([]);
  });

  it('reports a status that is not a usable identifier', () => {
    for (const bad of ['', '   ', 5, null]) {
      const issues = collect();
      expect(readStatus(bad, 'running', issues)).toBe('running');
      expect(issues[0]).toMatchObject({ field: 'status', code: 'invalid-status' });
    }
  });
});

describe('readEnum', () => {
  it('accepts an allowed value or an absent field', () => {
    const issues = collect();
    expect(readEnum('schedule', 'projectType', ['task', 'schedule'], 'task', issues)).toBe('schedule');
    expect(readEnum(undefined, 'projectType', ['task', 'schedule'], 'task', issues)).toBe('task');
    expect(issues).toEqual([]);
  });

  it('reports and defaults a value outside the closed vocabulary', () => {
    const issues = collect();
    expect(readEnum('schedul', 'projectType', ['task', 'schedule'], 'task', issues)).toBe('task');
    expect(issues[0]).toMatchObject({ field: 'projectType', code: 'invalid-enum' });
  });
});

describe('date readers', () => {
  it('keeps a readable date exactly as written', () => {
    const issues = collect();
    expect(readOptionalDate('2026-09-08T18:00:00.000Z', 'deadline', issues)).toBe(
      '2026-09-08T18:00:00.000Z',
    );
    expect(readOptionalDate('2026-09-08', 'deadline', issues)).toBe('2026-09-08');
    expect(issues).toEqual([]);
  });

  it('reports an unreadable date rather than passing NaN downstream', () => {
    const issues = collect();
    expect(readOptionalDate('next tuesday', 'deadline', issues)).toBe(null);
    expect(issues[0]).toMatchObject({ field: 'deadline', code: 'invalid-date' });
  });

  it('falls back for a required date, and reports it', () => {
    const issues = collect();
    expect(readDate('nonsense', 'createdAt', 'EPOCH', issues)).toBe('EPOCH');
    expect(issues[0]).toMatchObject({ code: 'invalid-date' });
  });

  it('does not complain about an absent optional date', () => {
    const issues = collect();
    expect(readOptionalDate(undefined, 'deadline', issues)).toBe(null);
    expect(issues).toEqual([]);
  });
});

describe('the malformed fixture vault', () => {
  it('loads every record rather than dropping the malformed ones', async () => {
    const { state } = await malformed();
    expect(state.projects).toHaveLength(1);
    expect(state.tasks).toHaveLength(10);
    expect(state.events).toHaveLength(2);
  });

  it('reports routing-critical project enums instead of silently defaulting them', async () => {
    const { state, problems } = await malformed();
    expect(state.projects[0]).toMatchObject({
      id: 'proj-bad-routing',
      status: 'active',
      projectType: 'task',
    });
    expect(problemsFor(problems, 'invalid-enum').map((problem) => problem.detail)).toEqual([
      expect.stringContaining('status'),
      expect.stringContaining('projectType'),
    ]);
  });

  it('substitutes a safe weight and reports the range', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-zero-weight')?.weight).toBe(1);
    expect(state.tasks.find((t) => t.id === 'task-negative-weight')?.weight).toBe(1);
    expect(state.tasks.find((t) => t.id === 'task-weight-text')?.weight).toBe(1);

    const reported = problemsFor(problems, 'bad-number').filter((p) => p.detail.startsWith('weight'));
    expect(reported.map((p) => p.id).sort()).toEqual([
      'task-negative-weight',
      'task-weight-text',
      'task-zero-weight',
    ]);
  });

  it('unsets a negative fixed duration and says the task will stretch', async () => {
    const { state, problems } = await malformed();
    const task = state.tasks.find((t) => t.id === 'task-fixed-negative');
    expect(task?.fixedDuration).toBe(null);
    expect(task?.isFixedDuration).toBe(true);

    const reported = problemsFor(problems, 'bad-number').filter((p) => p.id === 'task-fixed-negative');
    expect(reported).toHaveLength(2);
    expect(reported.some((p) => p.detail.includes('the task stretches'))).toBe(true);
  });

  it('unsets a cap of zero', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-cap-zero')?.maxDuration).toBe(null);
    expect(problemsFor(problems, 'bad-number').some((p) => p.id === 'task-cap-zero')).toBe(true);
  });

  it('reports an unreadable order index', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-order-text')?.orderIndex).toBe(0);
    expect(problemsFor(problems, 'bad-number').some((p) => p.id === 'task-order-text')).toBe(true);
  });

  it('reports a boolean written as yes', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-bool-yes')?.isCompleted).toBe(false);
    expect(problemsFor(problems, 'bad-boolean')[0]).toMatchObject({ id: 'task-bool-yes' });
  });

  it('reports an empty status and files the task under the default', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-empty-status')?.status).toBe('running');
    expect(problemsFor(problems, 'invalid-status')[0]).toMatchObject({ id: 'task-empty-status' });
  });

  it('reports unreadable dates on both tasks and events', async () => {
    const { state, problems } = await malformed();
    expect(state.tasks.find((t) => t.id === 'task-bad-deadline')?.deadline).toBe(null);
    expect(state.events.find((e) => e.id === 'evt-bad-start')?.startDate).toBe('');

    const dates = problemsFor(problems, 'bad-date');
    expect(dates.map((p) => p.id).sort()).toEqual(['evt-bad-start', 'task-bad-deadline']);
  });

  // The hazard this gate exists to close: nested keys hoisted to the top level would
  // have replaced the record's own id and status.
  it('does not let a nested mapping rewrite the record it sits in', async () => {
    const { state, problems } = await malformed();
    const task = state.tasks.find((t) => t.source.path.endsWith('task-nested.md'));
    expect(task?.id).toBe('task-nested');
    expect(task?.status).toBe('running');
    expect(state.tasks.some((t) => t.id === 'task-hijacked')).toBe(false);

    expect(problemsFor(problems, 'unsupported-frontmatter')).toHaveLength(1);
    expect(problemsFor(problems, 'unsupported-frontmatter')[0]).toMatchObject({
      kind: 'task',
      severity: 'warning',
    });
  });

  it('reports every problem against the file that caused it', async () => {
    const { problems } = await malformed();
    for (const problem of problems) {
      expect(problem.path).toMatch(/^Proxima\/(projects|tasks|events)\/.+\.md$/);
      expect(problem.detail).not.toBe('');
    }
  });
});

describe('malformed records cannot produce broken Elastic geometry', () => {
  it('yields finite, non-negative durations and heights', async () => {
    const { state } = await malformed();
    const board = elasticBoard(state.tasks, DEFAULT_STATUSES);
    const timeline = calculateElasticTimeline(
      board.running,
      new Date('2026-09-06T12:00:00.000Z'),
      new Date('2026-09-06T16:00:00.000Z'),
    );

    expect(board.running.length).toBeGreaterThan(0);
    for (const slice of timeline) {
      expect(Number.isFinite(slice.duration)).toBe(true);
      expect(slice.duration).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(new Date(slice.startTime).getTime())).toBe(false);
      expect(Number.isNaN(new Date(slice.endTime).getTime())).toBe(false);
    }

    const heights = elasticCardHeights(board.running, timeline, 800);
    for (const height of Object.values(heights)) {
      expect(Number.isFinite(height)).toBe(true);
      expect(height).toBeGreaterThan(0);
    }
  });

  it('sorts the board deterministically despite an unreadable order index', async () => {
    const { state } = await malformed();
    const first = elasticBoard(state.tasks, DEFAULT_STATUSES).running.map((t) => t.id);
    const second = elasticBoard(state.tasks, DEFAULT_STATUSES).running.map((t) => t.id);
    expect(first).toEqual(second);
  });
});
