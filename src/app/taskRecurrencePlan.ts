import { parseOpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  defineCanonicalRecurrenceRule,
  defineCanonicalRecurrenceSeries,
  parseOpaqueRecurrenceSeriesId,
  type CanonicalRecurrenceEnd,
  type CanonicalRecurrenceException,
  type CanonicalRecurrenceRule,
  type OpaqueRecurrenceSeriesId,
} from '../domain/canonicalRecurrence.js';
import type { Task } from '../domain/types.js';
import type { FormDraft } from './formDraft.js';
import type { TaskFieldMutation } from './taskMutations.js';

export const TASK_RECURRENCE_FIELD_IDS = [
  'recurrenceFrequency',
  'recurrenceInterval',
  'recurrenceEndKind',
  'recurrenceUntil',
  'recurrenceCount',
] as const;

export type TaskRecurrenceSeriesAllocator = () => OpaqueRecurrenceSeriesId;

export type TaskRecurrencePlan =
  | { readonly ok: true; readonly mutation: TaskFieldMutation | null }
  | {
      readonly ok: false;
      readonly reason: 'validation-refused';
      readonly detail: string;
      readonly fieldId: string;
    };

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function currentRule(task: Task): CanonicalRecurrenceRule | null {
  const value = objectValue(task.properties.recurrenceRule);
  if (value === null) return null;

  try {
    return defineCanonicalRecurrenceRule(value as CanonicalRecurrenceRule);
  } catch {
    return null;
  }
}

function currentSeries(task: Task): ReturnType<typeof defineCanonicalRecurrenceSeries> | null {
  const raw = objectValue(task.properties.recurrenceSeries);
  const rule = currentRule(task);
  if (raw === null || rule === null || typeof raw.seriesId !== 'string') return null;

  try {
    return defineCanonicalRecurrenceSeries({
      seriesId: parseOpaqueRecurrenceSeriesId(raw.seriesId),
      ownerKind: 'task',
      ownerRecordId: parseOpaqueRecordId(task.id),
      rule,
      exceptions: Array.isArray(raw.exceptions)
        ? raw.exceptions as readonly CanonicalRecurrenceException[]
        : [],
    });
  } catch {
    return null;
  }
}

export function taskRecurrenceValues(task: Task): Readonly<Record<string, string>> {
  const rule = currentRule(task);
  const end = rule?.end;

  return {
    recurrenceFrequency: rule?.frequency ?? 'daily',
    recurrenceInterval: rule === null ? '1' : String(rule.interval),
    recurrenceEndKind: rule === null ? 'none' : end!.kind,
    recurrenceUntil: end?.kind === 'until' ? end.until : '',
    recurrenceCount: end?.kind === 'count' ? String(end.count) : '',
  };
}

function weekdayOf(date: Date): 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()] as
    'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
}

function changed(task: Task, draft: FormDraft): boolean {
  const seed = taskRecurrenceValues(task);
  return TASK_RECURRENCE_FIELD_IDS.some(
    (id) => draft.values[id] !== undefined && draft.values[id] !== seed[id],
  );
}

function refused(detail: string, fieldId: string): TaskRecurrencePlan {
  return { ok: false, reason: 'validation-refused', detail, fieldId };
}

/**
 * Compile the Task editor's recurrence controls to the recurrence mutation D62 retained.
 *
 * No occurrence-specific operation is invented here. This form edits the owner task's series rule,
 * exactly as an Event editor's rule controls edit the owner event's rule. An occurrence gesture can
 * get a scope modal when a Task occurrence surface exists; that is not required to make the task
 * itself recurring.
 */
export function planTaskRecurrenceMutation(
  task: Task,
  draft: FormDraft,
  allocateSeriesId?: TaskRecurrenceSeriesAllocator,
): TaskRecurrencePlan {
  if (!changed(task, draft)) return { ok: true, mutation: null };

  if (task.properties.recurrenceUnreadable === true) {
    return refused(
      'this task recurs in a way the Task editor cannot represent, so the rule is not rewritten',
      'recurrenceFrequency',
    );
  }

  const seed = taskRecurrenceValues(task);
  const value = (id: string): string => draft.values[id] ?? seed[id] ?? '';
  const endKind = value('recurrenceEndKind');

  if (endKind === 'none') {
    return {
      ok: true,
      mutation: currentRule(task) === null && currentSeries(task) === null
        ? null
        : { kind: 'recurrence', value: null },
    };
  }

  if (!['never', 'until', 'count'].includes(endKind)) {
    return refused('a recurrence ends with Never, Until, Count, or does not repeat', 'recurrenceEndKind');
  }

  const frequency = value('recurrenceFrequency');
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) {
    return refused('recurrence frequency is Daily, Weekly, Monthly or Yearly', 'recurrenceFrequency');
  }

  const interval = Number(value('recurrenceInterval'));
  if (!Number.isSafeInteger(interval) || interval < 1) {
    return refused('recurrence interval is a positive whole number', 'recurrenceInterval');
  }

  const anchor = draft.values.startDate ?? task.startDate ?? '';
  if (anchor.trim() === '' || !Number.isFinite(Date.parse(anchor))) {
    return refused('a recurring task needs a readable start date', 'startDate');
  }

  let end: CanonicalRecurrenceEnd;
  if (endKind === 'never') {
    end = { kind: 'never' };
  } else if (endKind === 'until') {
    const until = value('recurrenceUntil').trim();
    if (until === '' || !Number.isFinite(Date.parse(until))) {
      return refused('Until needs a readable date', 'recurrenceUntil');
    }
    end = { kind: 'until', until };
  } else {
    const count = Number(value('recurrenceCount'));
    if (!Number.isSafeInteger(count) || count < 1) {
      return refused('Count is a positive whole number', 'recurrenceCount');
    }
    end = { kind: 'count', count };
  }

  const date = new Date(anchor);
  let rule: CanonicalRecurrenceRule;

  switch (frequency) {
    case 'daily':
      rule = { frequency: 'daily', interval, end };
      break;
    case 'weekly':
      rule = { frequency: 'weekly', interval, weekdays: [weekdayOf(date)], end };
      break;
    case 'monthly':
      rule = { frequency: 'monthly', interval, dayOfMonth: date.getUTCDate(), end };
      break;
    default:
      rule = {
        frequency: 'yearly',
        interval,
        month: date.getUTCMonth() + 1,
        dayOfMonth: date.getUTCDate(),
        end,
      };
      break;
  }

  const existing = currentSeries(task);
  const seriesId = existing?.seriesId ?? allocateSeriesId?.();
  if (seriesId === undefined) {
    return refused('starting task recurrence needs a recurrence-series id allocator', 'recurrenceEndKind');
  }

  try {
    return {
      ok: true,
      mutation: {
        kind: 'recurrence',
        value: defineCanonicalRecurrenceSeries({
          seriesId,
          ownerKind: 'task',
          ownerRecordId: parseOpaqueRecordId(task.id),
          rule: defineCanonicalRecurrenceRule(rule),
          exceptions: existing?.exceptions ?? [],
        }),
      },
    };
  } catch {
    return refused('the recurrence rule is not canonical', 'recurrenceEndKind');
  }
}
