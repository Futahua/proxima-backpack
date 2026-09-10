// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindElasticCockpitInteractions,
  elasticExecutionPresentation,
  renderElasticCockpit,
  type ElasticCockpitHandlers,
} from '../src/browser/elasticCockpit.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

function task(id: string, status: string, weight: number, properties: Record<string, unknown> = {}): Task {
  return {
    id,
    source: sourceRef('task', id),
    name: `Task ${id}`,
    description: `Description ${id}`,
    projectId: null,
    status,
    weight,
    orderIndex: 0,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: status === 'review',
    createdAt: '2026-09-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties,
  };
}

const runningA = task('running-a', 'running', 3, { priority: 'P1' });
const runningB = task('running-b', 'running', 1);
const backlog = task('backlog-a', 'backlog', 1);
const finished = task('finished-a', 'review', 1);

const state: ProximaState = {
  projects: [],
  tasks: [backlog, runningA, runningB, finished],
  events: [],
  statuses: [
    { id: 'backlog', name: 'Backlog', color: '#000', column: 'backlog' },
    { id: 'running', name: 'Running', color: '#000', column: 'running' },
    { id: 'review', name: 'Finished', color: '#000', column: 'finished' },
  ],
  taskSchema: [
    { id: 'priority', name: 'Priority', type: 'text' },
  ],
};

const session = {
  targetTime: '2026-09-06T16:00:00.000Z',
  lockedAt: null,
};

function render(selectedTaskId: string | null = null): string {
  return renderElasticCockpit({
    state,
    tasks: state.tasks,
    projectNames: new Map(),
    selectionLabel: 'All projects',
    session,
    now: new Date('2026-09-06T12:00:00.000Z'),
    selectedTaskId,
    dropRefusal: null,
    containerHeight: 800,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 2 Elastic execution cockpit', () => {
  it('sizes running cards from the execution target rather than task deadlines', () => {
    const presentation = elasticExecutionPresentation(
      [runningA, runningB],
      session,
      new Date('2026-09-06T12:00:00.000Z'),
      800,
    );

    expect(presentation.heights).toEqual({
      'running-a': 600,
      'running-b': 200,
    });
    expect(presentation.allocationMinutes['running-a']).toBe(180);
    expect(presentation.allocationMinutes['running-b']).toBe(60);
    expect(presentation.targetExpired).toBe(false);
  });

  it('advances deterministic per-task and overall progress while locked', () => {
    const locked = {
      targetTime: '2026-09-06T16:00:00.000Z',
      lockedAt: '2026-09-06T12:00:00.000Z',
    };

    const halfway = elasticExecutionPresentation(
      [runningA, runningB],
      locked,
      new Date('2026-09-06T14:00:00.000Z'),
      800,
    );

    expect(halfway.overallProgress).toBe(0.5);
    expect(halfway.progress['running-a']).toBeCloseTo(2 / 3);
    expect(halfway.progress['running-b']).toBe(0);

    const later = elasticExecutionPresentation(
      [runningA, runningB],
      locked,
      new Date('2026-09-06T15:30:00.000Z'),
      800,
    );

    expect(later.progress['running-a']).toBe(1);
    expect(later.progress['running-b']).toBeCloseTo(0.5);
  });

  it('renders execution controls, property pills and a read-only quick editor', () => {
    document.body.innerHTML = render('running-a');

    const harness = createInteractionHarness(document);

    expect(harness.target('elastic-target-input')).toBeInstanceOf(HTMLInputElement);
    expect(harness.target('elastic-lock')).toBeInstanceOf(HTMLButtonElement);
    expect(harness.target('elastic-property-running-a-priority').textContent).toContain('Priority');
    expect(harness.target('elastic-property-running-a-priority').textContent).toContain('P1');
    expect(harness.target('elastic-task-modal').getAttribute('role')).toBe('dialog');
    expect((harness.target('elastic-task-save') as HTMLButtonElement).disabled).toBe(true);
    expect((harness.target('elastic-task-delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('routes task opening, target changes, lock and unlock through the real DOM', () => {
    document.body.innerHTML = render();

    const calls: string[] = [];
    const handlers: ElasticCockpitHandlers = {
      openTask: (taskId) => calls.push(`open:${taskId}`),
      closeTask: () => calls.push('close'),
      setTarget: (targetTime) => calls.push(`target:${targetTime}`),
      lock: () => calls.push('lock'),
      unlock: () => calls.push('unlock'),
      moveTask: () => calls.push('move'),
    };

    bindElasticCockpitInteractions(document.body, handlers);
    const harness = createInteractionHarness(document);

    harness.click('elastic-task-running-a');
    harness.click('elastic-lock');

    const target = harness.target('elastic-target-input') as HTMLInputElement;
    target.value = '2026-09-06T17:00';
    target.dispatchEvent(new Event('change', { bubbles: true }));

    expect(calls).toEqual([
      'open:running-a',
      'lock',
      'target:2026-09-06T17:00:00.000Z',
    ]);
  });

  it('shows a correctly sized insertion placeholder before drop and emits one semantic move only on drop', () => {
    document.body.innerHTML = render();

    const moves: Array<{ taskId: string; targetColumn: string; targetIndex: number }> = [];
    bindElasticCockpitInteractions(document.body, {
      openTask: () => undefined,
      closeTask: () => undefined,
      setTarget: () => undefined,
      lock: () => undefined,
      unlock: () => undefined,
      moveTask: (intent) => moves.push(intent),
    });

    const harness = createInteractionHarness(document);
    const drag = harness.beginDrag('elastic-task-running-a', {
      clientX: 0,
      clientY: 0,
    });

    drag.move('elastic-drop-backlog-0', {
      clientX: 20,
      clientY: 20,
    });

    const source = harness.target('elastic-task-running-a');
    const placeholder = harness.target('elastic-placeholder-backlog-0');
    const slot = harness.target('elastic-drop-backlog-0');

    expect(source.dataset.elasticHeight).toBe('600');
    expect(placeholder.style.height).toBe('600px');
    expect(slot.dataset.elasticPreview).toBe('true');
    expect(moves).toEqual([]);

    drag.drop('elastic-drop-backlog-0', {
      clientX: 20,
      clientY: 20,
    });

    expect(moves).toEqual([
      {
        taskId: 'running-a',
        targetColumn: 'backlog',
        targetIndex: 0,
      },
    ]);
  });
});
