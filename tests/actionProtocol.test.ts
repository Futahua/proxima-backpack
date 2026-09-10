import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher, isActionResult, parseAction } from '../src/app/actionProtocol.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

async function fixtureDispatcher() {
  const loaded = await loadVaultState(fixtureVault('vault-basic'));
  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    clock: fixedClock('2026-09-06T12:00:00.000Z'),
  });
}

async function vaultByteHash(vault: ReturnType<typeof fixtureVault>): Promise<string> {
  const hash = createHash('sha256');

  for (const path of await vault.walk('')) {
    const file = await vault.read(path);
    hash.update(path);
    hash.update('\0');
    hash.update(file.text);
    hash.update('\0');
  }

  return hash.digest('hex');
}

describe('Gate 3A semantic action protocol', () => {
  it('rejects malformed actions with stable machine-readable errors', () => {
    expect(parseAction(null)).toEqual({ ok: false, error: { code: 'invalid-action', message: 'action must be an object with a string type', field: 'type' } });
    expect(parseAction({ type: 'calendar.shift-month', delta: 2 })).toEqual({ ok: false, error: { code: 'invalid-action-input', message: 'delta must be -1 or 1', field: 'delta' } });
    expect(parseAction({ type: 'unknown.action' })).toMatchObject({ ok: false, error: { code: 'invalid-action' } });
    expect(parseAction({ type: 'surface.select', surface: 'canvas' })).toEqual({ ok: true, action: { type: 'surface.select', surface: 'canvas' } });
    expect(parseAction({ type: 'surface.select', surface: 'board' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'surface' } });
    expect(parseAction({ type: 'tasks.mode.select', mode: 'bogus' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'mode' } });
    expect(parseAction({ type: 'timekeeping.panel.set-visible', panel: 'bogus', visible: true })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'panel' } });
    expect(parseAction({ type: 'timekeeping.panel.set-visible', panel: 'calendar', visible: 'yes' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'visible' } });
    expect(parseAction({ type: 'task.timeline.change', taskId: 'task-a', operation: 'resize-start', proposedStartDate: 'not-a-date', proposedDeadline: null, targetRowIndex: 0 })).toMatchObject({ ok: false, error: { code: 'invalid-action-input' } });
    expect(parseAction({ type: 'schedule.mode.select', mode: 'bogus' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'mode' } });
    expect(parseAction({ type: 'schedule.cursor.set', date: '2026-02-30' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'date' } });
    expect(parseAction({ type: 'project.workspace-tab.select', tab: 'bogus' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'tab' } });
    expect(parseAction({ type: 'calendar.navigate', direction: 'sideways' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'direction' } });
    expect(parseAction({ type: 'elastic.target.set', targetTime: 'not-a-date' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input', field: 'targetTime' } });
    expect(parseAction({ type: 'task.execution.move', taskId: 'task-1', targetColumn: 'sideways', targetIndex: 0 })).toMatchObject({ ok: false, error: { code: 'invalid-action-input' } });
    expect(parseAction({ type: 'event.schedule.change', eventId: 'event-1', operation: 'resize-start', proposedStartDate: '2026-09-06T10:00:00.000Z', proposedDeadline: '2026-09-06T11:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input' } });
    expect(parseAction({ type: 'event.schedule.create', name: '', projectId: null, description: '', startDate: '2026-09-06T10:00:00.000Z', deadline: '2026-09-06T11:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input' } });
    expect(parseAction({ type: 'event.schedule.recurrence.change', eventId: 'event-1', scope: 'future', occurrenceStartDate: '2026-09-06T10:00:00.000Z', proposedStartDate: '2026-09-06T10:00:00.000Z', proposedDeadline: '2026-09-06T11:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'invalid-action-input' } });
  });

  it('uses one dispatcher for cockpit navigation and keeps project selection across surfaces', async () => {
    const dispatcher = await fixtureDispatcher();

    expect(dispatcher.snapshot()).toMatchObject({
      surface: 'tasks',
      selection: 'all',
      tasksMode: 'elastic',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
      calendarMonth: '2026-09-01',
      stateRevision: 1,
    });

    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'proj-backpack' })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: true,
      stateRevision: 2,
    });

    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'schedule' })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: true,
      stateRevision: 3,
      snapshot: {
        surface: 'schedule',
        selection: 'proj-backpack',
      },
    });

    expect(dispatcher.dispatch({ type: 'schedule.mode.select', mode: 'week' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 4,
      snapshot: {
        scheduleMode: 'week',
      },
    });

    expect(dispatcher.dispatch({ type: 'calendar.navigate', direction: 'next' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 5,
      snapshot: {
        calendarMonth: '2026-10-01',
      },
    });

    expect(dispatcher.dispatch({ type: 'calendar.today' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 6,
      snapshot: {
        calendarMonth: '2026-09-01',
      },
    });

    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'projects' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 7,
    });

    expect(dispatcher.dispatch({ type: 'project.workspace-tab.select', tab: 'backlog' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 8,
      snapshot: {
        projectWorkspaceTab: 'backlog',
      },
    });

    expect(dispatcher.dispatch({ type: 'surface.select', surface: 'tasks' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 9,
      snapshot: {
        selection: 'proj-backpack',
      },
    });

    expect(dispatcher.dispatch({ type: 'tasks.mode.select', mode: 'timekeeping' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 10,
      snapshot: {
        tasksMode: 'timekeeping',
      },
    });

    const canvas = dispatcher.dispatch({ type: 'surface.select', surface: 'canvas' });
    expect(canvas).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 11,
      snapshot: {
        surface: 'canvas',
        selection: 'proj-backpack',
      },
    });
    expect(isActionResult(canvas)).toBe(true);

    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({
      ok: true,
      changed: true,
      stateRevision: 12,
      snapshot: {
        selection: 'all',
        surface: 'tasks',
        tasksMode: 'elastic',
        scheduleMode: 'month',
        projectWorkspaceTab: 'notes',
        calendarMonth: '2026-09-01',
      },
    });

    const noOp = dispatcher.dispatch({ type: 'fixture.reset' });
    expect(noOp).toMatchObject({ ok: true, changed: false, stateRevision: 12 });
    expect(isActionResult(dispatcher.dispatch({ type: 'calendar.shift-month', delta: -1 }))).toBe(true);
  });

  it('does not turn an unknown project id into an all-projects action', async () => {
    const dispatcher = await fixtureDispatcher();
    expect(dispatcher.dispatch({ type: 'project.select', projectId: 'not-a-project' })).toMatchObject({ ok: false, error: { code: 'project-not-found', field: 'projectId' }, stateRevision: 1 });
  });

  it('keeps month navigation canonical across year boundaries and supported edges', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, initialCalendarMonth: '2026-12-01', idGenerator: sequentialIdGenerator() });
    expect(dispatcher.dispatch({ type: 'calendar.shift-month', delta: 1 })).toMatchObject({ changed: true, snapshot: { calendarMonth: '2027-01-01' } });
    expect(dispatcher.dispatch({ type: 'calendar.shift-month', delta: -1 })).toMatchObject({ changed: true, snapshot: { calendarMonth: '2026-12-01' } });
    const low = createActionDispatcher({ state: loaded.state, initialCalendarMonth: '0099-12-01', idGenerator: sequentialIdGenerator() });
    expect(low.dispatch({ type: 'calendar.shift-month', delta: 1 })).toMatchObject({ changed: true, snapshot: { calendarMonth: '0100-01-01' } });
    const floor = createActionDispatcher({ state: loaded.state, initialCalendarMonth: '0000-01-01', idGenerator: sequentialIdGenerator() });
    expect(floor.dispatch({ type: 'calendar.shift-month', delta: -1 })).toMatchObject({ changed: false, snapshot: { calendarMonth: '0000-01-01' } });
    const ceiling = createActionDispatcher({ state: loaded.state, initialCalendarMonth: '9999-12-01', idGenerator: sequentialIdGenerator() });
    expect(ceiling.dispatch({ type: 'calendar.shift-month', delta: 1 })).toMatchObject({ changed: false, snapshot: { calendarMonth: '9999-12-01' } });
    expect(dispatcher.dispatch({ type: 'calendar.select-month', month: '2031-04-01' })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: true,
      snapshot: {
        calendarMonth: '2031-04-01',
      },
    });
    expect(dispatcher.dispatch({ type: 'calendar.select-month', month: '2031-04-01' })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: false,
      snapshot: {
        calendarMonth: '2031-04-01',
      },
    });
  });

  it('keeps the exact Schedule civil-date cursor as disposable local state', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const before = await vaultByteHash(vault);
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      initialScheduleDate: '2026-09-06',
    });

    expect(dispatcher.snapshot().scheduleDate)
      .toBe('2026-09-06');

    expect(dispatcher.dispatch({
      type: 'schedule.cursor.set',
      date: '2027-02-28',
    })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: true,
      snapshot: {
        scheduleDate: '2027-02-28',
      },
    });

    expect(dispatcher.dispatch({
      type: 'schedule.cursor.set',
      date: '2027-02-28',
    })).toMatchObject({
      ok: true,
      category: 'local-state',
      changed: false,
      snapshot: {
        scheduleDate: '2027-02-28',
      },
    });

    expect(await vaultByteHash(vault)).toBe(before);
  });

  it('falls back invalid initial months and remains canonical through repeated shifts', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, initialCalendarMonth: '2026-13-40', idGenerator: sequentialIdGenerator() });
    expect(dispatcher.snapshot().calendarMonth).toBe('2026-09-01');
    for (let index = 0; index < 24; index += 1) {
      dispatcher.dispatch({ type: 'calendar.shift-month', delta: 1 });
      expect(dispatcher.snapshot().calendarMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])-01$/);
    }
  });

  it('leaves every durable fixture byte unchanged across cockpit navigation', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      clock: fixedClock('2026-09-06T12:00:00.000Z'),
    });

    const before = await vaultByteHash(vault);

    const actions = [
      { type: 'project.select', projectId: 'proj-term' },
      { type: 'surface.select', surface: 'projects' },
      { type: 'project.workspace-tab.select', tab: 'deadlines' },
      { type: 'surface.select', surface: 'schedule' },
      { type: 'schedule.mode.select', mode: 'day' },
      { type: 'schedule.cursor.set', date: '2026-09-05' },
      { type: 'schedule.mode.select', mode: 'four-day' },
      { type: 'schedule.cursor.set', date: '2026-09-09' },
      { type: 'schedule.mode.select', mode: 'week' },
      { type: 'schedule.cursor.set', date: '2026-09-16' },
      { type: 'schedule.mode.select', mode: 'month' },
      { type: 'schedule.cursor.set', date: '2026-10-16' },
      { type: 'schedule.mode.select', mode: 'year' },
      { type: 'schedule.cursor.set', date: '2027-10-16' },
      { type: 'schedule.mode.select', mode: 'agenda' },
      { type: 'schedule.cursor.set', date: '2027-11-16' },
      { type: 'calendar.navigate', direction: 'next' },
      { type: 'calendar.today' },
      { type: 'surface.select', surface: 'tasks' },
      { type: 'tasks.mode.select', mode: 'timekeeping' },
      { type: 'timekeeping.panel.set-visible', panel: 'timeline', visible: true },
      { type: 'timekeeping.panel.set-visible', panel: 'countdowns', visible: true },
      { type: 'timekeeping.panel.set-visible', panel: 'calendar', visible: false },
      { type: 'timekeeping.panel.set-visible', panel: 'calendar', visible: true },
      { type: 'tasks.mode.select', mode: 'elastic' },
      { type: 'surface.select', surface: 'canvas' },
    ];

    for (const action of actions) {
      expect(dispatcher.dispatch(action)).toMatchObject({
        ok: true,
        category: 'local-state',
      });
    }

    const after = await vaultByteHash(vault);

    expect(after).toBe(before);
    expect(dispatcher.snapshot().selection).toBe('proj-term');
  });

  it('keeps Elastic target, lock and unlock as disposable local state', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const clock = fixedClock('2026-09-06T12:00:00.000Z');
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      clock,
    });

    expect(dispatcher.snapshot()).toMatchObject({
      elasticTargetTime: '2026-09-06T16:00:00.000Z',
      elasticLockedAt: null,
    });

    expect(dispatcher.dispatch({
      type: 'elastic.target.set',
      targetTime: '2026-09-06T18:00:00.000Z',
    })).toMatchObject({
      ok: true,
      category: 'local-state',
      snapshot: {
        elasticTargetTime: '2026-09-06T18:00:00.000Z',
        elasticLockedAt: null,
      },
    });

    expect(dispatcher.dispatch({ type: 'elastic.lock' })).toMatchObject({
      ok: true,
      category: 'local-state',
      snapshot: {
        elasticTargetTime: '2026-09-06T18:00:00.000Z',
        elasticLockedAt: '2026-09-06T12:00:00.000Z',
      },
    });

    expect(dispatcher.dispatch({
      type: 'elastic.target.set',
      targetTime: '2026-09-06T19:00:00.000Z',
    })).toMatchObject({
      ok: false,
      category: 'local-state',
      outcome: 'semantic-conflict',
    });

    clock.advance(60 * 60 * 1000);

    expect(dispatcher.dispatch({ type: 'elastic.unlock' })).toMatchObject({
      ok: true,
      category: 'local-state',
      snapshot: {
        elasticTargetTime: '2026-09-06T18:00:00.000Z',
        elasticLockedAt: null,
      },
    });
  });

  it('refuses task execution writes and leaves every durable fixture byte unchanged', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      clock: fixedClock('2026-09-06T12:00:00.000Z'),
    });
    const task = loaded.state.tasks[0]!;
    const before = await vaultByteHash(vault);

    dispatcher.dispatch({
      type: 'elastic.target.set',
      targetTime: '2026-09-06T17:00:00.000Z',
    });
    dispatcher.dispatch({ type: 'elastic.lock' });
    dispatcher.dispatch({ type: 'elastic.unlock' });
    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({
      ok: true,
      category: 'local-state',
    });

    const move = dispatcher.dispatch({
      type: 'task.execution.move',
      taskId: task.id,
      targetColumn: 'running',
      targetIndex: 0,
    });

    const after = await vaultByteHash(vault);

    expect(move).toMatchObject({
      ok: false,
      category: 'record-mutation',
      outcome: 'unavailable',
      entityIds: [task.id],
      error: {
        code: 'action-not-available',
      },
    });
    expect(after).toBe(before);
  });

  it('refuses Schedule move and bottom-edge resize writes as typed unavailable mutations without changing fixture bytes', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      clock: fixedClock('2026-09-06T12:00:00.000Z'),
    });
    const event = loaded.state.events[0]!;
    const before = await vaultByteHash(vault);

    for (const operation of ['move', 'resize-end'] as const) {
      const result = dispatcher.dispatch({
        type: 'event.schedule.change',
        eventId: event.id,
        operation,
        proposedStartDate: '2026-09-07T10:00:00.000Z',
        proposedDeadline: '2026-09-07T11:00:00.000Z',
      });

      expect(result).toMatchObject({
        ok: false,
        actionType: 'event.schedule.change',
        category: 'record-mutation',
        outcome: 'unavailable',
        entityIds: [event.id],
        error: {
          code: 'action-not-available',
        },
      });
      expect(isActionResult(result)).toBe(true);
    }

    const after = await vaultByteHash(vault);
    expect(after).toBe(before);
  });

  it('refuses Schedule event creation as typed unavailable and leaves every durable fixture byte unchanged', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
      clock: fixedClock('2026-09-06T12:00:00.000Z'),
    });
    const before = await vaultByteHash(vault);

    const result = dispatcher.dispatch({
      type: 'event.schedule.create',
      name: 'New event',
      projectId: null,
      description: '',
      startDate: '2026-09-08T10:15:00.000Z',
      deadline: '2026-09-08T11:15:00.000Z',
    });

    const after = await vaultByteHash(vault);

    expect(result).toMatchObject({
      ok: false,
      actionType: 'event.schedule.create',
      category: 'record-mutation',
      outcome: 'unavailable',
      entityIds: [],
      error: {
        code: 'action-not-available',
      },
    });
    expect(isActionResult(result)).toBe(true);
    expect(after).toBe(before);
  });

  it('refuses eventual recurring-occurrence or series writes as typed unavailable and leaves fixture bytes unchanged', async () => {
    const vault = fixtureVault('vault-basic');
    const loaded = await loadVaultState(vault);
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture', clock: fixedClock('2026-09-06T12:00:00.000Z') });
    const event = loaded.state.events[0]!;
    const before = await vaultByteHash(vault);
    for (const scope of ['occurrence', 'series'] as const) {
      const result = dispatcher.dispatch({ type: 'event.schedule.recurrence.change', eventId: event.id, scope, occurrenceStartDate: '2026-09-08T10:00:00.000Z', proposedStartDate: '2026-09-08T10:15:00.000Z', proposedDeadline: '2026-09-08T11:15:00.000Z' });
      expect(result).toMatchObject({ ok: false, actionType: 'event.schedule.recurrence.change', category: 'record-mutation', outcome: 'unavailable', entityIds: [event.id], error: { code: 'action-not-available' } });
      expect(isActionResult(result)).toBe(true);
    }
    expect(await vaultByteHash(vault)).toBe(before);
  });

  it('keeps fixture-only reset unavailable for a live dispatcher', async () => {
    const fixture = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: fixture.state, mode: 'live' });
    expect(dispatcher.dispatch({ type: 'fixture.reset' })).toMatchObject({ ok: false, error: { code: 'action-not-available' } });
  });

  it('settles synchronously and emits deterministic accepted/rejected events for the same actions', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-basic'));
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, clock: fixedClock('2026-09-06T12:00:00.000Z'), idGenerator: sequentialIdGenerator(), eventCapacity: 8 });
    const accepted = dispatcher.dispatch({ type: 'project.select', projectId: 'proj-backpack' });
    const rejected = dispatcher.dispatch({ type: 'project.select', projectId: 'missing' });
    expect(accepted).toMatchObject({ ok: true, requestId: 'request-0001', stateRevision: 2 });
    expect(rejected).toMatchObject({ ok: false, requestId: 'request-0002', stateRevision: 2 });
    expect(dispatcher.snapshot()).toMatchObject({ stateRevision: 2, settled: true, settledRevision: 2, latestEventSequence: 3 });
    expect(dispatcher.events().map((event) => [event.sequence, event.kind, event.stateRevision])).toEqual([[1, 'action.accepted', 2], [2, 'state.settled', 2], [3, 'action.rejected', 2]]);
    expect(dispatcher.events(2)[0]).toMatchObject({ sequence: 3, errorCode: 'project-not-found', timestamp: '2026-09-06T12:00:00.000Z' });
  });
});
