// Stage 0 of the full-parity checklist: before any surface is rebuilt, every action
// result has to answer two questions on its own - what did this cost, and what actually
// happened - because an agent is a first-class caller and cannot infer either from the
// absence of a thrown error.
//
// The rule these tests pin is the one the checklist calls binding: a caller must never
// have to deduce success. Losing a race, being refused as stale, and failing to reach
// storage demand three different responses, and only the last is worth alarming anyone
// about.
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { createActionDispatcher, isActionResult, parseAction } from '../src/app/actionProtocol.js';
import {
  ACTION_CATEGORIES,
  ACTION_OUTCOMES,
  categoryOf,
  isActionCategory,
  isActionOutcome,
  isAmbiguousOutcome,
  isMutationCategory,
  isRetryableAfterRefetch,
  isTerminalRefusal,
  outcomeForErrorCode,
  registeredActionTypes,
  type ActionCategory,
  type ActionErrorCode,
  type ActionOutcome,
} from '../src/app/actionTaxonomy.js';

const SOURCE = '---\nid: p1\nname: Project One\nstatus: active\nprojectType: task\n---\nbody\n';

async function dispatcher(mode: 'fixture' | 'live' = 'fixture') {
  const vault = createMemoryVault({ 'Proxima/projects/p1.md': SOURCE });
  const loaded = await loadVaultState(vault);
  return createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode });
}

const ERROR_CODES: ActionErrorCode[] = [
  'invalid-action',
  'invalid-action-input',
  'project-not-found',
  'record-not-found',
  'action-not-available',
  'stale-revision',
  'semantic-conflict',
  'recovery-required',
  'storage-failure',
];

describe('Stage 0 action taxonomy', () => {
  it('classifies every registered action type; an unregistered one is not defaulted', () => {
    for (const type of registeredActionTypes()) {
      expect(isActionCategory(categoryOf(type))).toBe(true);
    }
    // Defaulting an unknown type to 'presentation' would let a durable write cross a
    // boundary that believes nothing durable happens, so undefined is the answer.
    expect(categoryOf('task.execution.move')).toBe('record-mutation');
    expect(categoryOf('event.schedule.change')).toBe('record-mutation');
    expect(categoryOf('event.schedule.create')).toBe('record-mutation');
    expect(categoryOf('project.create')).toBe('record-mutation');
    expect(categoryOf('project.archive')).toBe('record-mutation');
    expect(categoryOf('project.restore')).toBe('record-mutation');
    expect(categoryOf('project.delete')).toBe('record-mutation');
    expect(categoryOf('event.schedule.recurrence.change')).toBe('record-mutation');
    expect(categoryOf('schedule.cursor.set')).toBe('local-state');
    expect(categoryOf('calendar.select-month')).toBe('local-state');
    expect(categoryOf('elastic.target.set')).toBe('local-state');
    expect(categoryOf('elastic.lock')).toBe('local-state');
    expect(categoryOf('elastic.unlock')).toBe('local-state');
    expect(categoryOf('')).toBeUndefined();
    expect(categoryOf('toString')).toBeUndefined();
  });

  it('covers the four action kinds in one union, and names the two with no action yet', () => {
    // The checklist asks for one public versioned union covering presentation actions,
    // local-state actions, record mutations and vault-artifact gestures. Those are this
    // taxonomy's four categories, and `actionProtocol.ts` proves at compile time that the
    // `ProximaAction` union and this registry name exactly the same types
    // (`ACTION_TAXONOMY_MATCHES_PROTOCOL`). What is left to state at runtime is which of
    // the four kinds the product actually populates today.
    expect(ACTION_CATEGORIES).toEqual([
      'presentation',
      'local-state',
      'record-mutation',
      'artifact-mutation',
    ]);

    const populated: Record<ActionCategory, string[]> = {
      presentation: [],
      'local-state': [],
      'record-mutation': [],
      'artifact-mutation': [],
    };

    for (const type of registeredActionTypes()) {
      const category = categoryOf(type);
      expect(isActionCategory(category)).toBe(true);
      populated[category as ActionCategory].push(type);
    }

    expect(populated['local-state'].length).toBeGreaterThan(0);
    expect(populated['record-mutation'].length).toBeGreaterThan(0);
    // Nothing is a pure presentation action: every cockpit gesture that changes what is
    // shown also has to record which way the reader left it, so it is local state. And
    // no action mutates an ordinary vault file yet — the Notes/drawings write stage owns
    // that. Ticking either box means giving these two lists a member.
    expect(populated.presentation).toEqual([]);
    expect(populated['artifact-mutation']).toEqual([]);

    // Only the two mutation categories can cost the creator something, which is why an
    // unregistered type may never be defaulted into one of the other two.
    expect(ACTION_CATEGORIES.filter(isMutationCategory))
      .toEqual(['record-mutation', 'artifact-mutation']);
    expect(isMutationCategory('presentation')).toBe(false);
    expect(isMutationCategory('local-state')).toBe(false);
  });

  it('maps every error code to exactly one outcome, and never to accepted', () => {
    const seen = new Set<ActionOutcome>();
    for (const code of ERROR_CODES) {
      const outcome = outcomeForErrorCode(code);
      expect(isActionOutcome(outcome)).toBe(true);
      expect(outcome).not.toBe('accepted');
      seen.add(outcome);
    }
    // Every non-accepted outcome is reachable from some code: an outcome a caller can
    // never actually receive is a branch nobody tests.
    expect([...seen].sort()).toEqual(ACTION_OUTCOMES.filter((o) => o !== 'accepted').slice().sort());
  });

  it('separates the outcomes that may be retried from the ones that may not', () => {
    expect(isRetryableAfterRefetch('stale-revision')).toBe(true);
    expect(isRetryableAfterRefetch('semantic-conflict')).toBe(true);

    // A blind retry of a refused-as-stale toggle is how one silently undoes an edit
    // somebody else already made, so retry means refetch and re-decide, never resend.
    expect(isRetryableAfterRefetch('recovery-required')).toBe(false);
    expect(isAmbiguousOutcome('recovery-required')).toBe(true);
    expect(isAmbiguousOutcome('storage-failure')).toBe(false);

    for (const outcome of ['validation-refused', 'not-found', 'unavailable'] as const) {
      expect(isTerminalRefusal(outcome)).toBe(true);
      expect(isRetryableAfterRefetch(outcome)).toBe(false);
    }
    // Ambiguity is neither success nor failure, so it must not read as terminal either.
    expect(isTerminalRefusal('recovery-required')).toBe(false);
  });

  it('knows which categories can cost the creator something', () => {
    expect(ACTION_CATEGORIES.filter(isMutationCategory)).toEqual(['record-mutation', 'artifact-mutation']);
    expect(isMutationCategory('presentation')).toBe(false);
    // The Elastic lock lives here: the plugin persisted it to Obsidian settings, but
    // that was a storage accident, not a reason to charge it against creator data.
    expect(isMutationCategory('local-state')).toBe(false);
  });
});

describe('Stage 0 dispatcher results', () => {
  it('an accepted action reports its category, outcome and affected records', async () => {
    const d = await dispatcher();
    const result = d.dispatch({ type: 'project.select', projectId: 'p1' });
    expect(result).toMatchObject({ ok: true, outcome: 'accepted', category: 'local-state', entityIds: ['p1'] });
    expect(isActionResult(result)).toBe(true);
  });

  it('a local cockpit action reports no affected records rather than omitting the field', async () => {
    const d = await dispatcher();
    const result = d.dispatch({ type: 'calendar.shift-month', delta: 1 });
    expect(result).toMatchObject({ ok: true, outcome: 'accepted', category: 'local-state' });
    // Absent and empty must not be the same thing to a caller reading the result.
    expect(result.entityIds).toEqual([]);
  });

  it('a missing project is not-found, and names the record it could not find', async () => {
    const d = await dispatcher();
    const result = d.dispatch({ type: 'project.select', projectId: 'no-such-project' });
    expect(result).toMatchObject({
      ok: false,
      outcome: 'not-found',
      category: 'local-state',
      entityIds: ['no-such-project'],
      error: { code: 'project-not-found' },
    });
    expect(isActionResult(result)).toBe(true);
  });

  it('an unrecognised action type has no category to report, and says so', async () => {
    const d = await dispatcher();
    const result = d.dispatch({ type: 'stage0.unregistered-probe' });
    expect(result).toMatchObject({ ok: false, outcome: 'validation-refused', category: 'unknown' });
    expect(isActionResult(result)).toBe(true);
  });

  it('an unavailable action is refused as unavailable, not as invalid', async () => {
    const d = await dispatcher('live');
    const result = d.dispatch({ type: 'fixture.reset' });
    // The request was well formed; the capability was absent. A caller retries one of
    // those and not the other.
    expect(result).toMatchObject({ ok: false, outcome: 'unavailable', error: { code: 'action-not-available' } });
    expect(isTerminalRefusal('unavailable')).toBe(true);
  });

  it('malformed input is refused before anything is dispatched', async () => {
    const d = await dispatcher();
    const before = d.snapshot();
    for (const input of [null, 'project.select', { projectId: 'p1' }, { type: 'calendar.shift-month', delta: 2 }]) {
      const result = d.dispatch(input);
      expect(result).toMatchObject({ ok: false, outcome: 'validation-refused' });
      expect(isActionResult(result)).toBe(true);
    }
    const after = d.snapshot();
    expect(after.stateRevision).toBe(before.stateRevision);
    expect(after.selection).toBe(before.selection);
    expect(after.surface).toBe(before.surface);
  });

  it('parseAction keeps its narrow shape, so validation stays separable from dispatch', () => {
    // The taxonomy lives on results, not on parse: a parse failure has no state
    // revision, no request id and nothing to report about the world.
    expect(parseAction({ type: 'surface.select', surface: 'canvas' })).toEqual({
      ok: true,
      action: { type: 'surface.select', surface: 'canvas' },
    });
  });
});

describe('Stage 0 boundary guard', () => {
  it('rejects a result that cannot say what happened', async () => {
    const d = await dispatcher();
    const good = d.dispatch({
      type: 'surface.select',
      surface: 'schedule',
    });

    expect(isActionResult(good)).toBe(true);

    // Each of these is a shape that would previously have passed and left an agent
    // guessing from the absence of an error.
    expect(isActionResult({ ...good, outcome: undefined })).toBe(false);
    expect(isActionResult({ ...good, outcome: 'done' })).toBe(false);
    expect(isActionResult({ ...good, category: undefined })).toBe(false);
    expect(isActionResult({ ...good, category: 'unknown' })).toBe(false);
    expect(isActionResult({ ...good, entityIds: undefined })).toBe(false);
    expect(isActionResult({ ...good, entityIds: [1, 2] })).toBe(false);
  });

  it('rejects a success claiming a failure outcome, and a failure claiming acceptance', async () => {
    const d = await dispatcher();
    const ok = d.dispatch({
      type: 'surface.select',
      surface: 'tasks',
    });
    const failed = d.dispatch({
      type: 'project.select',
      projectId: 'missing',
    });

    expect(isActionResult({ ...ok, outcome: 'stale-revision' })).toBe(false);
    expect(isActionResult({ ...failed, outcome: 'accepted' })).toBe(false);
  });

  it('allows a failure to report an unknown category, because an unparsed type has none', async () => {
    const d = await dispatcher();
    const result = d.dispatch({ type: 'nonsense.action' });

    expect(result).toMatchObject({ category: 'unknown' });
    expect(isActionResult(result)).toBe(true);
  });

  it('rejects a result whose action type and category disagree', async () => {
    const d = await dispatcher();
    const accepted = d.dispatch({
      type: 'surface.select',
      surface: 'schedule',
    });
    const failed = d.dispatch({
      type: 'project.select',
      projectId: 'missing',
    });

    expect(isActionResult({
      ...accepted,
      category: 'record-mutation',
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      actionType: 'nonsense.action',
    })).toBe(false);

    expect(isActionResult({
      ...failed,
      category: 'artifact-mutation',
    })).toBe(false);
  });

  it('rejects a failure whose public error code and outcome disagree', async () => {
    const d = await dispatcher();
    const failed = d.dispatch({
      type: 'project.select',
      projectId: 'missing',
    });

    expect(failed.ok).toBe(false);
    if (failed.ok) {
      throw new Error('expected project.select to fail');
    }

    expect(isActionResult({
      ...failed,
      outcome: 'storage-failure',
    })).toBe(false);

    expect(isActionResult({
      ...failed,
      error: {
        ...failed.error,
        code: 'not-a-real-code',
      },
    })).toBe(false);

    expect(isActionResult({
      ...failed,
      error: {
        ...failed.error,
        field: 42,
      },
    })).toBe(false);
  });

  it('rejects malformed revision, request id and snapshot fields at the public boundary', async () => {
    const d = await dispatcher();
    const accepted = d.dispatch({
      type: 'surface.select',
      surface: 'schedule',
    });

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      throw new Error('expected surface.select to succeed');
    }

    expect(isActionResult({
      ...accepted,
      stateRevision: Number.NaN,
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      stateRevision: Number.POSITIVE_INFINITY,
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      stateRevision: 1.5,
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      stateRevision: -1,
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      requestId: '',
    })).toBe(false);

    expect(isActionResult({
      ...accepted,
      snapshot: {
        ...accepted.snapshot,
        calendarMonth: '2026-13-01',
      },
    })).toBe(false);
    expect(isActionResult({
      ...accepted,
      snapshot: {
        ...accepted.snapshot,
        scheduleDate: '2026-02-30',
      },
    })).toBe(false);
  });
});
