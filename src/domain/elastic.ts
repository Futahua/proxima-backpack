/**
 * The Elastic timeline.
 *
 * This is the behaviour that makes Proxima Proxima: running tasks stretch to fill
 * the time actually remaining before a deadline. Fixed-duration tasks are carved
 * out of the budget first; everything else divides what is left in proportion to
 * its weight, capped by maxDuration.
 *
 * The pinned contract is recorded in docs/DECISIONS.md (D9) and covered by the
 * Gate 1C edge suite. Pure: no clock, no host, no I/O. The caller supplies both instants.
 */
import type { ElasticColumn, StatusDefinition, Task, TimelineSlice } from './types.js';

export const DEFAULT_STATUSES: StatusDefinition[] = [
  { id: 'backlog', name: 'Elastic Backlog', color: '#636e72', column: 'backlog' },
  { id: 'running', name: 'Elastic Running', color: '#00b894', column: 'running' },
  { id: 'review', name: 'Finished', color: '#fdcb6e', column: 'finished' },
];

/** Status ids the original plugin treated as finished regardless of configuration. */
const LEGACY_FINISHED = new Set(['review', 'finished', 'done']);
const LEGACY_BACKLOG = new Set(['backlog']);

/**
 * Which Elastic column a task belongs to.
 *
 * Membership is always derived from the task's own status and completion, never
 * stored, so a task cannot disagree with the column it is drawn in. Anything not
 * recognisably backlog or finished is running — that default is deliberate and
 * matches the original board.
 */
export function columnOf(task: Task, statuses: StatusDefinition[] = DEFAULT_STATUSES): ElasticColumn {
  if (task.isCompleted) return 'finished';
  const defined = statuses.find((s) => s.id === task.status);
  if (defined) return defined.column;
  if (LEGACY_FINISHED.has(task.status)) return 'finished';
  if (LEGACY_BACKLOG.has(task.status)) return 'backlog';
  return 'running';
}

/** Tasks in one column, in board order. Does not mutate the input array. */
export function tasksInColumn(
  tasks: Task[],
  column: ElasticColumn,
  statuses: StatusDefinition[] = DEFAULT_STATUSES,
): Task[] {
  return tasks
    .filter((t) => columnOf(t, statuses) === column)
    .slice()
    .sort((a, b) => (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0));
}

/**
 * Lay the given tasks end to end between startTime and deadline.
 *
 * Returns one slice per task in the order given. An empty result means the
 * deadline is not in the future — that is a real answer, not a failure.
 */
export function calculateElasticTimeline(
  tasks: Task[],
  startTime: Date,
  deadline: Date,
): TimelineSlice[] {
  const totalMinutes = (deadline.getTime() - startTime.getTime()) / 60000;
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return [];

  const durations = new Map<string, number>();
  let remaining = totalMinutes;

  for (const task of tasks) {
    if (isFixed(task)) {
      durations.set(task.id, task.fixedDuration as number);
      remaining -= task.fixedDuration as number;
    }
  }

  const elastic = tasks.filter((t) => !isFixed(t));
  if (elastic.length > 0 && remaining > 0) {
    const totalWeight = elastic.reduce((sum, t) => sum + t.weight, 0) || 1;
    for (const task of elastic) {
      let duration = (task.weight / totalWeight) * remaining;
      if (task.maxDuration && duration > task.maxDuration) duration = task.maxDuration;
      durations.set(task.id, duration);
    }
  }

  let cursor = startTime.getTime();
  const slices: TimelineSlice[] = [];
  for (const task of tasks) {
    const duration = durations.get(task.id) ?? 0;
    const end = cursor + duration * 60000;
    slices.push({
      taskId: task.id,
      startTime: new Date(cursor).toISOString(),
      endTime: new Date(end).toISOString(),
      duration,
    });
    cursor = end;
  }
  return slices;
}

/**
 * Card heights for the running column, in pixels.
 *
 * A task's share of the visible column is its share of the timeline, so the board
 * reads as time rather than as a list. When there is no usable timeline — deadline
 * passed, or nothing but zero-length slices — it falls back to weight, which keeps
 * the board legible instead of collapsing every card to nothing.
 */
export function elasticCardHeights(
  running: Task[],
  timeline: TimelineSlice[],
  containerHeight: number,
  minimumHeight = 125,
): Record<string, number> {
  const heights: Record<string, number> = {};
  if (running.length === 0) return heights;

  const total = timeline.reduce((sum, slice) => sum + slice.duration, 0);

  if (total <= 0 || containerHeight <= 0) {
    const totalWeight = running.reduce((sum, t) => sum + t.weight, 0) || 1;
    const usable = Math.max(containerHeight, 300);
    for (const task of running) {
      heights[task.id] = Math.max(minimumHeight, (task.weight / totalWeight) * usable);
    }
    return heights;
  }

  for (const task of running) {
    const slice = timeline.find((s) => s.taskId === task.id);
    const duration = slice ? slice.duration : 0;
    heights[task.id] = Math.max(minimumHeight, (duration / total) * containerHeight);
  }
  return heights;
}

function isFixed(task: Task): boolean {
  return Boolean(task.isFixedDuration && task.fixedDuration && task.fixedDuration > 0);
}
