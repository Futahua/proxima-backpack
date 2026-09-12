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

/**
 * The Elastic drop's canonical operation names live here rather than in the shell.
 *
 * The gesture writes a record instead of dispatching a refusal, so the shell routes it to
 * `moveTaskByGesture` and the module that owns the gesture is what names the operation. The
 * vocabulary is unchanged; its home moved with the behaviour.
 */
const TASK_MOVE_GESTURE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/taskMoveGesture.ts'),
  'utf8',
);

/**
 * The project verbs' canonical names live here rather than in the shell, for the same reason: once
 * the Projects Hub's forms and lifecycle controls were wired to the sequences, the shell names
 * `createProjectFromFormAction` and `runProjectLifecycle` instead of an action type, and the
 * vocabulary moved with the behaviour.
 */
const PROJECT_LIFECYCLE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/projectLifecycleActions.ts'),
  'utf8',
);

/** The Gantt's write sequence, where the three bar operations' names now live. */
const TIMELINE_CHANGE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/timelineChangeAction.ts'),
  'utf8',
);

/** The Schedule's write sequences, where the two gesture verbs' names now live. */
const EVENT_WRITE_ACTIONS_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/eventWriteActions.ts'),
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
      'elastic.target.set',
      'elastic.lock',
      'elastic.unlock',
      'calendar.navigate',
      'calendar.today',
      'schedule.mode.select',
      'schedule.cursor.set',
      'canvas.node.select',
      'canvas.node.geometry.change',
      'canvas.node.remove',
    ];

    for (const type of browserSemanticActionTypes) {
      expect(MAIN_SOURCE).toContain(`type: '${type}'`);
    }

    // The Elastic drag is the one mutation the shell reaches through its operation path, and
    // it still speaks the taxonomy's own names for the two things a drop can be.
    expect(MAIN_SOURCE).toContain('performElasticDrop(');
    expect(MAIN_SOURCE).not.toContain("type: 'task.execution.move'");
    expect(TASK_MOVE_GESTURE_SOURCE).toContain(
      "'task.execution.move'",
    );
    expect(TASK_MOVE_GESTURE_SOURCE).toContain(
      "'task.execution.reorder'",
    );

    // The five project verbs left the dispatcher the same way, when the Hub's two forms and its
    // three lifecycle controls were wired: the shell reaches the sequences, and the vocabulary
    // lives with the behaviour rather than with the caller.
    expect(MAIN_SOURCE).toContain('createProjectFromFormAction(');
    expect(MAIN_SOURCE).toContain('saveProjectEditAction(');
    expect(MAIN_SOURCE).toContain('runProjectLifecycle(');
    expect(MAIN_SOURCE).not.toContain("type: 'project.create'");
    expect(PROJECT_LIFECYCLE_SOURCE).toContain(
      "export type ProjectLifecycleVerb = 'create' | 'update' | 'archive' | 'restore' | 'delete';",
    );

    // The Schedule's two verbs went the same way, and their vocabulary lives in the module that owns
    // the write: a move is a reschedule (the new start, the record's duration) and a resize is a new
    // end, which is what the grid's binder hands over instead of an action type.
    expect(MAIN_SOURCE).toContain('createEventFromSeed(');
    expect(MAIN_SOURCE).toContain('changeEventFromGesture(');
    expect(MAIN_SOURCE).not.toContain("type: 'event.schedule.create'");
    expect(MAIN_SOURCE).not.toContain("type: 'event.schedule.change'");
    expect(EVENT_WRITE_ACTIONS_SOURCE).toContain(
      "export type EventWriteVerb = 'create' | 'update' | 'delete' | 'reschedule' | 'resize';",
    );

    // The Gantt's date change went the same way: the shell reaches the sequence, and the three
    // operations a bar gesture can be live in the module that owns the write.
    expect(MAIN_SOURCE).toContain('changeTaskDatesFromGantt(');
    expect(MAIN_SOURCE).not.toContain("type: 'task.timeline.change'");
    expect(TIMELINE_CHANGE_SOURCE).toContain("export type TimelineChangeOperation = 'move' | 'resize-start' | 'resize-end';");

    // The shell reaches the refresh sequence too. It used to be `void executeSourceRefreshAction({` inside
    // the click chain's template branch and fired in parallel with the run; the branch moved into the
    // composer's binding, whose post-run step is async, so it is awaited after the write instead of
    // discarded - the same reach, one step later, which is what "after the write" should have meant.
    expect(MAIN_SOURCE).toContain(
      'executeSourceRefreshAction({',
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
    // `project.create` and the two Schedule mutations no longer belong to this list: the dispatcher
    // still refuses them — the case below proves that through the headless dispatcher — but no
    // browser surface reaches them that way any more, so claiming the shell exposes them would be
    // claiming callers that are gone.
    for (const type of [
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
