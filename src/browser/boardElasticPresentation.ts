import { calculateElasticTimeline, elasticCardHeights } from '../domain/elastic.js';
import type { Task } from '../domain/types.js';

export type DeadlineState = 'future' | 'expired' | 'none';

export interface BoardElasticPresentation {
  heights: Record<string, number>;
  deadlineState: Record<string, DeadlineState>;
  timelineEnd: Date;
  usedFallbackTimeline: boolean;
}

/** Computes the browser board's bounded timeline and visible card metadata. */
export function boardElasticPresentation(running: Task[], now: Date, containerHeight: number): BoardElasticPresentation {
  const deadlineState: Record<string, DeadlineState> = {};
  const futureDeadlines: Date[] = [];
  let hasExpired = false;
  for (const task of running) {
    if (!task.deadline) { deadlineState[task.id] = 'none'; continue; }
    const date = new Date(task.deadline);
    if (!Number.isFinite(date.getTime())) { deadlineState[task.id] = 'none'; continue; }
    if (date.getTime() > now.getTime()) { deadlineState[task.id] = 'future'; futureDeadlines.push(date); }
    else { deadlineState[task.id] = 'expired'; hasExpired = true; }
  }
  futureDeadlines.sort((a, b) => a.getTime() - b.getTime());
  const end = hasExpired ? new Date(now.getTime()) : (futureDeadlines[0] ?? new Date(now.getTime() + 8 * 60 * 60 * 1000));
  const timeline = calculateElasticTimeline(running, now, end);
  return { heights: elasticCardHeights(running, timeline, containerHeight), deadlineState, timelineEnd: end, usedFallbackTimeline: timeline.length === 0 };
}
