import { describe, expect, it } from 'vitest';
import { boardElasticPresentation } from '../src/browser/boardElasticPresentation.js';
import type { Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

function task(overrides: Partial<Task> & { id: string }): Task {
  return { source: sourceRef('task', overrides.id), name: overrides.id, description: '', projectId: null, status: 'running', weight: 1, orderIndex: 0, isFixedDuration: false, fixedDuration: null, maxDuration: null, isCompleted: false, createdAt: '2026-09-01T00:00:00.000Z', startDate: null, deadline: null, properties: {}, ...overrides };
}

const now = new Date('2026-09-07T12:00:00.000Z');

describe('Gate 6.2B board elastic presentation', () => {
  it('maps weighted timeline durations to visible minimum heights', () => {
    const result = boardElasticPresentation([task({ id: 'a', weight: 3, deadline: '2026-09-07T16:00:00.000Z' }), task({ id: 'b', weight: 1, deadline: '2026-09-07T16:00:00.000Z' })], now, 800);
    expect(result.heights).toEqual({ a: 600, b: 200 });
    expect(result.deadlineState).toEqual({ a: 'future', b: 'future' });
  });

  it('makes fixed duration and maxDuration cap effects visible', () => {
    const result = boardElasticPresentation([task({ id: 'fixed', weight: 1, isFixedDuration: true, fixedDuration: 60, deadline: '2026-09-07T16:00:00.000Z' }), task({ id: 'capped', weight: 9, maxDuration: 30, deadline: '2026-09-07T16:00:00.000Z' })], now, 600);
    expect(result.heights.fixed!).toBeGreaterThan(result.heights.capped!);
    expect(result.heights.capped!).toBe(200);
  });

  it('uses the domain fallback for expired deadlines and marks them overdue', () => {
    const result = boardElasticPresentation([task({ id: 'expired', deadline: '2026-09-07T11:00:00.000Z' }), task({ id: 'undated' })], now, 460);
    expect(result.usedFallbackTimeline).toBe(true);
    expect(result.deadlineState).toEqual({ expired: 'expired', undated: 'none' });
    expect(result.heights.expired).toBe(230);
    expect(result.timelineEnd.getTime()).toBe(now.getTime());
  });

  it('uses the fallback when expired/equal deadlines coexist with future work', () => {
    const mixed = boardElasticPresentation([task({ id: 'expired', deadline: '2026-09-07T11:00:00.000Z' }), task({ id: 'future', deadline: '2026-09-07T16:00:00.000Z' })], now, 460);
    expect(mixed.usedFallbackTimeline).toBe(true);
    expect(mixed.timelineEnd.getTime()).toBe(now.getTime());
    const equal = boardElasticPresentation([task({ id: 'equal', deadline: '2026-09-07T12:00:00.000Z' }), task({ id: 'future', deadline: '2026-09-07T16:00:00.000Z' })], now, 460);
    expect(equal.usedFallbackTimeline).toBe(true);
    expect(equal.timelineEnd.getTime()).toBe(now.getTime());
  });
});
