import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createActionDispatcher,
  type ProximaAction,
} from '../src/app/actionProtocol.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  fixedClock,
  sequentialIdGenerator,
} from '../src/domain/clock.js';
import { fixtureVault } from './fixtures.js';

const MAIN_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/browser/main.ts'),
  'utf8',
);

const SOURCE_REFRESH_ACTION_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/sourceRefreshAction.ts'),
  'utf8',
);

async function dispatcher() {
  const loaded = await loadVaultState(
    fixtureVault('vault-basic'),
  );

  return createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    initialSourceRevision: 1,
    initialCalendarMonth: '2026-09-01',
    clock: fixedClock('2026-09-06T12:00:00.000Z'),
    idGenerator: sequentialIdGenerator(),
  });
}

describe('Stage 6 slice 18 UI semantic-action parity', () => {
  it('funnels browser semantic action execution through exactly one canonical dispatcher bridge', () => {
    expect(
      MAIN_SOURCE.match(/actionDispatcher\.dispatch\(/g),
    ).toHaveLength(1);

    expect(MAIN_SOURCE).toContain(
      'const result = actionDispatcher.dispatch(input);',
    );

    expect(MAIN_SOURCE).toContain(
      'function dispatchAction(input: unknown): ActionResult | null {',
    );
  });

  it('uses canonical semantic action names at the current browser interaction boundaries', () => {
    const browserSemanticActionTypes = [
      'surface.select',
      'tasks.mode.select',
      'project.workspace-tab.select',
      'project.select',
      'project.create',
      'elastic.target.set',
      'elastic.lock',
      'elastic.unlock',
      'task.execution.move',
      'task.timeline.change',
      'calendar.navigate',
      'calendar.today',
      'schedule.mode.select',
      'schedule.cursor.set',
      'event.schedule.create',
      'event.schedule.change',
      'canvas.node.select',
      'canvas.node.geometry.change',
      'canvas.node.remove',
    ];

    for (const type of browserSemanticActionTypes) {
      expect(MAIN_SOURCE).toContain(`type: '${type}'`);
    }

    expect(MAIN_SOURCE).toContain(
      'void executeSourceRefreshAction({',
    );
    expect(MAIN_SOURCE).toContain(
      'dispatch: (input) => dispatchAction(input),',
    );
    expect(SOURCE_REFRESH_ACTION_SOURCE).toContain(
      "dependencies.dispatch({ type: 'source.refresh' })",
    );
  });

  it('drives the same canonical navigation actions directly through the headless dispatcher', async () => {
    const d = await dispatcher();

    const actions: ProximaAction[] = [
      {
        type: 'surface.select',
        surface: 'projects',
      },
      {
        type: 'tasks.mode.select',
        mode: 'timekeeping',
      },
      {
        type: 'project.workspace-tab.select',
        tab: 'task-board',
      },
      {
        type: 'source.refresh',
      },
    ];

    const results = actions.map((action) =>
      d.dispatch(action),
    );

    expect(
      results.map((result) => result.actionType),
    ).toEqual(
      actions.map((action) => action.type),
    );
    expect(
      results.every((result) => result.ok),
    ).toBe(true);

    expect(d.snapshot()).toMatchObject({
      surface: 'projects',
      tasksMode: 'timekeeping',
      projectWorkspaceTab: 'task-board',
    });
  });

  it('keeps browser-exposed mutation intents on the same typed-unavailable dispatcher contract used by tests', async () => {
    for (const type of [
      'project.create',
      'event.schedule.create',
      'canvas.node.remove',
    ]) {
      expect(MAIN_SOURCE).toContain(`type: '${type}'`);
    }

    const d = await dispatcher();
    const beforeState = JSON.stringify(d.snapshot().state);
    const beforeRevision = d.snapshot().stateRevision;

    const actions: ProximaAction[] = [
      {
        type: 'project.create',
        name: 'Unavailable project',
        description: 'record-store cutover has not happened',
      },
      {
        type: 'event.schedule.create',
        name: 'Unavailable event',
        projectId: null,
        description: '',
        startDate: '2026-09-07T09:00:00.000Z',
        deadline: '2026-09-07T10:00:00.000Z',
      },
      {
        type: 'canvas.node.remove',
        nodeId: 'canvas-node-0001',
      },
    ];

    for (const action of actions) {
      const result = d.dispatch(action);

      expect(result).toMatchObject({
        ok: false,
        actionType: action.type,
        category: 'record-mutation',
        outcome: 'unavailable',
        stateRevision: beforeRevision,
        error: {
          code: 'action-not-available',
        },
      });
    }

    expect(JSON.stringify(d.snapshot().state))
      .toBe(beforeState);
    expect(d.snapshot().stateRevision)
      .toBe(beforeRevision);
  });
});
