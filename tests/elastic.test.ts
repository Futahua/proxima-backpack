import { describe, expect, it } from 'vitest';
import {
  calculateElasticTimeline,
  columnOf,
  elasticCardHeights,
  DEFAULT_STATUSES,
} from '../src/domain/elastic.js';
import type { Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    source: sourceRef('task', overrides.id),
    name: overrides.id,
    description: '',
    projectId: null,
    status: 'running',
    weight: 1,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
    ...overrides,
  };
}

const start = new Date('2026-09-06T12:00:00.000Z');
const inFourHours = new Date('2026-09-06T16:00:00.000Z');

describe('calculateElasticTimeline', () => {
  it('divides the window in proportion to weight', () => {
    const timeline = calculateElasticTimeline(
      [task({ id: 'a', weight: 3 }), task({ id: 'b', weight: 1 })],
      start,
      inFourHours,
    );
    expect(timeline.map((s) => s.duration)).toEqual([180, 60]);
    expect(timeline[0]!.startTime).toBe('2026-09-06T12:00:00.000Z');
    expect(timeline[1]!.startTime).toBe('2026-09-06T15:00:00.000Z');
    expect(timeline[1]!.endTime).toBe('2026-09-06T16:00:00.000Z');
  });

  it('reserves fixed durations before anything stretches', () => {
    const timeline = calculateElasticTimeline(
      [
        task({ id: 'fixed', isFixedDuration: true, fixedDuration: 60 }),
        task({ id: 'x', weight: 1 }),
        task({ id: 'y', weight: 1 }),
      ],
      start,
      inFourHours,
    );
    expect(timeline.map((s) => s.duration)).toEqual([60, 90, 90]);
  });

  it('caps a task at maxDuration and does not redistribute the remainder', () => {
    const timeline = calculateElasticTimeline(
      [task({ id: 'capped', weight: 1, maxDuration: 30 }), task({ id: 'free', weight: 1 })],
      start,
      inFourHours,
    );
    expect(timeline[0]!.duration).toBe(30);
    expect(timeline[1]!.duration).toBe(120);
  });

  it('returns nothing when the deadline is not in the future', () => {
    expect(calculateElasticTimeline([task({ id: 'a' })], inFourHours, start)).toEqual([]);
    expect(calculateElasticTimeline([task({ id: 'a' })], start, start)).toEqual([]);
  });

  it('gives zero-length slices when fixed durations already exceed the window', () => {
    const timeline = calculateElasticTimeline(
      [
        task({ id: 'long', isFixedDuration: true, fixedDuration: 600 }),
        task({ id: 'squeezed', weight: 1 }),
      ],
      start,
      inFourHours,
    );
    expect(timeline[0]!.duration).toBe(600);
    expect(timeline[1]!.duration).toBe(0);
  });
});

describe('columnOf', () => {
  it('treats completion as finished whatever the status says', () => {
    expect(columnOf(task({ id: 'a', status: 'running', isCompleted: true }))).toBe('finished');
  });

  it('recognises the configured statuses', () => {
    expect(columnOf(task({ id: 'a', status: 'backlog' }), DEFAULT_STATUSES)).toBe('backlog');
    expect(columnOf(task({ id: 'a', status: 'review' }), DEFAULT_STATUSES)).toBe('finished');
  });

  it('defaults an unknown status to running rather than hiding the task', () => {
    expect(columnOf(task({ id: 'a', status: 'something-else' }))).toBe('running');
  });
});

describe('elasticCardHeights', () => {
  it('sizes cards by their share of the timeline', () => {
    const running = [task({ id: 'a', weight: 3 }), task({ id: 'b', weight: 1 })];
    const timeline = calculateElasticTimeline(running, start, inFourHours);
    const heights = elasticCardHeights(running, timeline, 800);
    expect(heights.a).toBe(600);
    expect(heights.b).toBe(200);
  });

  it('never draws a card below the minimum height', () => {
    const running = [task({ id: 'a', weight: 99 }), task({ id: 'b', weight: 1 })];
    const timeline = calculateElasticTimeline(running, start, inFourHours);
    expect(elasticCardHeights(running, timeline, 300).b).toBe(125);
  });

  it('falls back to weight when there is no usable timeline', () => {
    const running = [task({ id: 'a', weight: 1 }), task({ id: 'b', weight: 1 })];
    const heights = elasticCardHeights(running, [], 600);
    expect(heights.a).toBe(300);
    expect(heights.b).toBe(300);
  });
});
