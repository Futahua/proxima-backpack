/**
 * Retained task recurrence: the planner's delivered contract.
 *
 * D62 retains task recurrence. This test proves the API that the implementation actually
 * exposes: a task can start a canonical recurrence series through a caller-supplied series
 * allocator, an existing series can change rule without changing its identity or exceptions,
 * and clearing recurrence produces a null recurrence mutation.
 *
 * Occurrence-specific operations are deliberately not tested here: the delivered
 * taskRecurrencePlan module does not expose them. The planner's own contract says occurrence
 * gestures require a future occurrence surface; inventing a second API in this test would
 * make the test describe functionality the implementation does not claim to provide.
 */
import { describe, expect, it } from 'vitest';

import {
  defineCanonicalRecurrenceRule,
  defineCanonicalRecurrenceSeries,
  opaqueRecurrenceSeriesIdFromRandomBytes,
} from '../src/domain/canonicalRecurrence.js';
import { opaqueRecordIdFromRandomBytes } from '../src/domain/canonicalIdentity.js';
import { planTaskRecurrenceMutation, taskRecurrenceValues } from '../src/app/taskRecurrencePlan.js';
import type { FormDraft } from '../src/app/formDraft.js';
import type { Task } from '../src/domain/types.js';

const TASK_ID = opaqueRecordIdFromRandomBytes(new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]));

const SERIES_ID = opaqueRecurrenceSeriesIdFromRandomBytes(new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]));

const ANCHOR = '2026-09-10T09:00:00.000Z';

function task(properties: Record<string, unknown> = {}): Task {
  return {
    id: TASK_ID,
    source: {
      path: `Proxima/tasks/${TASK_ID}.md`,
      revision: 'r1',
      kind: 'task',
      idOrigin: 'record-store',
    },
    name: 'Recurring task',
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
    startDate: ANCHOR,
    deadline: null,
    properties,
  };
}

function draft(values: Record<string, string>): FormDraft {
  return {
    values,
    checks: {},
    selections: {},
  };
}

describe('task recurrence planner', () => {
  it('starts a task-owned canonical series with the caller-supplied series id', () => {
    const result = planTaskRecurrenceMutation(
      task(),
      draft({
        recurrenceFrequency: 'weekly',
        recurrenceInterval: '2',
        recurrenceEndKind: 'never',
        recurrenceUntil: '',
        recurrenceCount: '',
      }),
      () => SERIES_ID,
    );

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.mutation).not.toBeNull();
    expect(result.mutation?.kind).toBe('recurrence');

    if (result.mutation?.kind !== 'recurrence') return;

    const series = result.mutation.value;
    if (series === null) throw new Error('a recurrence mutation must carry a series');

    expect(series.seriesId).toBe(SERIES_ID);
    expect(series.ownerKind).toBe('task');
    expect(series.ownerRecordId).toBe(TASK_ID);
    expect(series.rule).toEqual(
      defineCanonicalRecurrenceRule({
        frequency: 'weekly',
        interval: 2,
        weekdays: ['thu'],
        end: { kind: 'never' },
      }),
    );
    expect(series.exceptions).toEqual([]);
  });

  it('refuses to start a series when no series-id allocator is supplied', () => {
    const result = planTaskRecurrenceMutation(
      task(),
      draft({
        recurrenceFrequency: 'daily',
        recurrenceInterval: '1',
        recurrenceEndKind: 'never',
        recurrenceUntil: '',
        recurrenceCount: '',
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'validation-refused',
      detail: 'starting task recurrence needs a recurrence-series id allocator',
      fieldId: 'recurrenceEndKind',
    });
  });

  it('preserves an existing series id and exceptions when its rule changes', () => {
    const existingRule = defineCanonicalRecurrenceRule({
      frequency: 'daily',
      interval: 1,
      end: { kind: 'never' },
    });

    const exception = {
      occurrence: {
        seriesId: SERIES_ID,
        scheduledStart: '2026-09-11T09:00:00.000Z',
      },
      state: 'cancelled' as const,
    };

    const existingSeries = defineCanonicalRecurrenceSeries({
      seriesId: SERIES_ID,
      ownerKind: 'task',
      ownerRecordId: TASK_ID,
      rule: existingRule,
      exceptions: [exception],
    });

    const existing = task({
      recurrenceRule: existingRule,
      recurrenceSeries: existingSeries,
    });

    const result = planTaskRecurrenceMutation(
      existing,
      draft({
        recurrenceFrequency: 'weekly',
        recurrenceInterval: '2',
        recurrenceEndKind: 'never',
        recurrenceUntil: '',
        recurrenceCount: '',
      }),
    );

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.mutation).not.toBeNull();

    if (result.mutation?.kind !== 'recurrence') return;

    const series = result.mutation.value;
    if (series === null) throw new Error('a recurrence mutation must carry a series');

    expect(series.seriesId).toBe(SERIES_ID);
    expect(series.ownerKind).toBe('task');
    expect(series.ownerRecordId).toBe(TASK_ID);
    expect(series.exceptions).toEqual(existingSeries.exceptions);
    expect(series.rule).toEqual(
      defineCanonicalRecurrenceRule({
        frequency: 'weekly',
        interval: 2,
        weekdays: ['thu'],
        end: { kind: 'never' },
      }),
    );
  });

  it('clears an existing task recurrence with a null mutation', () => {
    const rule = defineCanonicalRecurrenceRule({
      frequency: 'monthly',
      interval: 1,
      dayOfMonth: 10,
      end: { kind: 'never' },
    });

    const series = defineCanonicalRecurrenceSeries({
      seriesId: SERIES_ID,
      ownerKind: 'task',
      ownerRecordId: TASK_ID,
      rule,
      exceptions: [],
    });

    const existing = task({
      recurrenceRule: rule,
      recurrenceSeries: series,
    });

    const result = planTaskRecurrenceMutation(
      existing,
      draft({
        recurrenceEndKind: 'none',
      }),
    );

    expect(result).toEqual({
      ok: true,
      mutation: {
        kind: 'recurrence',
        value: null,
      },
    });
  });

  it('seeds recurrence controls from the existing canonical rule', () => {
    const rule = defineCanonicalRecurrenceRule({
      frequency: 'yearly',
      interval: 3,
      month: 9,
      dayOfMonth: 10,
      end: { kind: 'count', count: 7 },
    });

    const series = defineCanonicalRecurrenceSeries({
      seriesId: SERIES_ID,
      ownerKind: 'task',
      ownerRecordId: TASK_ID,
      rule,
      exceptions: [],
    });

    expect(taskRecurrenceValues(task({
      recurrenceRule: rule,
      recurrenceSeries: series,
    }))).toEqual({
      recurrenceFrequency: 'yearly',
      recurrenceInterval: '3',
      recurrenceEndKind: 'count',
      recurrenceUntil: '',
      recurrenceCount: '7',
    });
  });
});
