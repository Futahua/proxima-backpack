/**
 * Retained task recurrence: the planner's pure contract.
 *
 * D62 retains task recurrence. The chosen semantics are the canonical
 * series/occurrence semantics already used by events:
 *
 * - a task owns one recurrence series;
 * - a new series receives the caller's opaque series id;
 * - changing the rule preserves that series id and its existing exceptions;
 * - an occurrence override is valid only for a slot the rule actually generates;
 * - the override is keyed by the scheduled slot, not by the moved-to instant;
 * - clearing recurrence writes a null recurrence mutation.
 *
 * This suite deliberately tests the planner without a store. Persistence is already
 * owned by taskMutations; this file proves that the task-specific recurrence plan
 * produces the right typed mutation and refuses impossible occurrence targets.
 */
import { describe, expect, it } from 'vitest';

import {
  defineCanonicalRecurrenceRule,
  defineCanonicalRecurrenceSeries,
  opaqueRecurrenceSeriesIdFromRandomBytes,
} from '../src/domain/canonicalRecurrence.js';
import { opaqueRecordIdFromRandomBytes } from '../src/domain/canonicalIdentity.js';
import {
  occurrenceExceptionsOf,
  planOccurrenceException,
  planRecurrenceClear,
  planRecurrenceSet,
  recurrenceRuleOf,
  seriesOf,
} from '../src/app/taskRecurrencePlan.js';

const TASK_ID = opaqueRecordIdFromRandomBytes(new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]));

const ANCHOR = '2026-09-10T09:00:00.000Z';

function seriesId(lastByte: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = lastByte;
  return opaqueRecurrenceSeriesIdFromRandomBytes(bytes);
}

const DAILY = defineCanonicalRecurrenceRule({
  frequency: 'daily',
  interval: 1,
  end: { kind: 'never' },
});

const EVERY_TWO_DAYS = defineCanonicalRecurrenceRule({
  frequency: 'daily',
  interval: 2,
  end: { kind: 'never' },
});

type SetTask = Parameters<typeof planRecurrenceSet>[0];
type OccurrenceTask = Parameters<typeof planOccurrenceException>[0];

function taskForSet(
  properties: Record<string, unknown> = {},
): SetTask {
  return {
    id: TASK_ID,
    startDate: ANCHOR,
    properties,
  } as SetTask;
}

function taskForOccurrence(
  properties: Record<string, unknown> = {},
): OccurrenceTask {
  return {
    id: TASK_ID,
    startDate: ANCHOR,
    properties,
  } as OccurrenceTask;
}

function recurrenceProperties(
  recurrenceSeriesId: ReturnType<typeof seriesId>,
  exceptions: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    recurrenceRule: DAILY,
    recurrenceSeries: {
      seriesId: recurrenceSeriesId,
      exceptions,
    },
  };
}

describe('retained task recurrence planner', () => {
  it('creates a task-owned series and clears it with the typed recurrence mutation', () => {
    const created = planRecurrenceSet(
      taskForSet(),
      DAILY,
      () => seriesId(11),
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.mutations).toHaveLength(1);

    const mutation = created.mutations[0]!;
    expect(mutation.kind).toBe('recurrence');

    if (mutation.kind !== 'recurrence' || mutation.value === null) {
      throw new Error('expected a recurrence mutation carrying a series');
    }

    expect(mutation.value.seriesId).toBe(seriesId(11));
    expect(mutation.value.ownerKind).toBe('task');
    expect(mutation.value.ownerRecordId).toBe(TASK_ID);
    expect(mutation.value.rule).toEqual(DAILY);
    expect(mutation.value.exceptions).toEqual([]);

    expect(planRecurrenceClear()).toEqual({
      ok: true,
      mutations: [
        {
          kind: 'recurrence',
          value: null,
        },
      ],
    });
  });

  it('preserves the series identity and existing exceptions when the task rule changes', () => {
    const existingSeriesId = seriesId(21);
    const existing = defineCanonicalRecurrenceSeries({
      seriesId: existingSeriesId,
      ownerKind: 'task',
      ownerRecordId: TASK_ID,
      rule: DAILY,
      exceptions: [
        {
          occurrence: {
            seriesId: existingSeriesId,
            scheduledStart: '2026-09-11T09:00:00.000Z',
          },
          state: 'cancelled',
        },
      ],
    });

    const planned = planRecurrenceSet(
      taskForSet({
        recurrenceRule: existing.rule,
        recurrenceSeries: {
          seriesId: existing.seriesId,
          exceptions: existing.exceptions,
        },
      }),
      EVERY_TWO_DAYS,
      () => seriesId(99),
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const mutation = planned.mutations[0]!;
    expect(mutation.kind).toBe('recurrence');

    if (mutation.kind !== 'recurrence' || mutation.value === null) {
      throw new Error('expected the changed rule to remain a recurrence mutation');
    }

    expect(mutation.value.seriesId).toBe(existingSeriesId);
    expect(mutation.value.ownerKind).toBe('task');
    expect(mutation.value.ownerRecordId).toBe(TASK_ID);
    expect(mutation.value.rule).toEqual(EVERY_TWO_DAYS);
    expect(mutation.value.exceptions).toEqual(existing.exceptions);
  });

  it('accepts only generated occurrence slots and replaces an exception for the same slot', () => {
    const existingSeriesId = seriesId(31);
    const input = taskForOccurrence(
      recurrenceProperties(existingSeriesId),
    );

    expect(seriesOf(input)).toMatchObject({
      seriesId: existingSeriesId,
      ownerKind: 'task',
      ownerRecordId: TASK_ID,
    });
    expect(recurrenceRuleOf(input)).toEqual(DAILY);
    expect(occurrenceExceptionsOf(input)).toEqual([]);

    const notGenerated = planOccurrenceException(
      input,
      '2026-09-11T09:30:00.000Z',
      { kind: 'cancel' },
    );

    expect(notGenerated).toMatchObject({
      ok: false,
      reason: 'not-a-generated-occurrence',
    });

    const first = planOccurrenceException(
      input,
      '2026-09-11T09:00:00.000Z',
      {
        kind: 'reschedule',
        startDate: '2026-09-11T14:00:00.000Z',
        deadline: '2026-09-11T14:15:00.000Z',
      },
    );

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstMutation = first.mutations[0]!;
    expect(firstMutation.kind).toBe('recurrence');

    if (firstMutation.kind !== 'recurrence' || firstMutation.value === null) {
      throw new Error('expected an occurrence exception inside the recurrence mutation');
    }

    expect(firstMutation.value.seriesId).toBe(existingSeriesId);
    expect(firstMutation.value.exceptions).toEqual([
      {
        occurrence: {
          seriesId: existingSeriesId,
          scheduledStart: '2026-09-11T09:00:00.000Z',
        },
        state: 'rescheduled',
        startDate: '2026-09-11T14:00:00.000Z',
        deadline: '2026-09-11T14:15:00.000Z',
      },
    ]);

    const movedAgain = planOccurrenceException(
      {
        ...input,
        properties: {
          recurrenceRule: DAILY,
          recurrenceSeries: {
            seriesId: existingSeriesId,
            exceptions: firstMutation.value.exceptions,
          },
        },
      },
      '2026-09-11T09:00:00.000Z',
      {
        kind: 'reschedule',
        startDate: '2026-09-11T17:00:00.000Z',
        deadline: '2026-09-11T17:15:00.000Z',
      },
    );

    expect(movedAgain.ok).toBe(true);
    if (!movedAgain.ok) return;

    const movedAgainMutation = movedAgain.mutations[0]!;
    expect(movedAgainMutation.kind).toBe('recurrence');

    if (movedAgainMutation.kind !== 'recurrence' || movedAgainMutation.value === null) {
      throw new Error('expected the repeated occurrence edit to remain a recurrence mutation');
    }

    expect(movedAgainMutation.value.exceptions).toHaveLength(1);
    expect(movedAgainMutation.value.exceptions[0]).toEqual({
      occurrence: {
        seriesId: existingSeriesId,
        scheduledStart: '2026-09-11T09:00:00.000Z',
      },
      state: 'rescheduled',
      startDate: '2026-09-11T17:00:00.000Z',
      deadline: '2026-09-11T17:15:00.000Z',
    });
  });

  it('cancels a generated occurrence without changing the task-owned series rule', () => {
    const existingSeriesId = seriesId(41);
    const input = taskForOccurrence(
      recurrenceProperties(existingSeriesId),
    );

    const cancelled = planOccurrenceException(
      input,
      '2026-09-12T09:00:00.000Z',
      { kind: 'cancel' },
    );

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    const mutation = cancelled.mutations[0]!;
    expect(mutation.kind).toBe('recurrence');

    if (mutation.kind !== 'recurrence' || mutation.value === null) {
      throw new Error('expected cancellation to preserve the recurrence series');
    }

    expect(mutation.value.seriesId).toBe(existingSeriesId);
    expect(mutation.value.ownerKind).toBe('task');
    expect(mutation.value.ownerRecordId).toBe(TASK_ID);
    expect(mutation.value.rule).toEqual(DAILY);
    expect(mutation.value.exceptions).toEqual([
      {
        occurrence: {
          seriesId: existingSeriesId,
          scheduledStart: '2026-09-12T09:00:00.000Z',
        },
        state: 'cancelled',
      },
    ]);
  });
});
