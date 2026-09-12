/**
 * Scoped ordering, and the surfaces that must not contaminate one another.
 *
 * Three order-ish facts share this tree and only two of them are durable: `executionOrder` (one global
 * Elastic queue per execution state) and `workflowOrder` (one ordering per exact project + stage pair).
 * Gantt row placement is **local state** by the HARD GATE A/A3 decision, with a pure helper and no record
 * field — which is the opposite of what `docs/DECISIONS.md#d64` still says, and that contradiction is
 * corrected there rather than worked around here.
 *
 * The cases build one world where the three orders deliberately disagree - Alpha is first in the queue,
 * last in its stage and earliest by date; Beta is the reverse of the queue and the stage and latest by
 * date; Gamma sits between them in each - so a surface that read the wrong scope could not pass by
 * accident. Each case then changes exactly one scope and asserts four things: the intended scope moved, the
 * other scope's *stored* values did not, the surface that draws the other scope renders what it rendered
 * before, and the surface that draws the changed scope renders the new order. The local third scope is
 * asserted the only way local state can be: the store's files and revisions are byte-identical afterwards.
 */
import { describe, expect, it } from 'vitest';
import { projectBacklog } from '../src/app/backlogView.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  GANTT_ROW_PLACEMENT_CATEGORY,
  placeCanonicalGanttRow,
} from '../src/domain/canonicalOrdering.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { EMPTY_PROJECT_BACKLOG_VIEW } from '../src/browser/projectBacklog.js';
import { renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { renderProjectWorkflowBoard } from '../src/browser/projectWorkflowBoard.js';
import { timelineGanttProjection } from '../src/browser/timekeepingCockpit.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import type { RecordStoreFileName } from '../src/ports/recordStore.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:00:00+07:00';
const NOW = new Date('2026-09-06T12:00:00.000Z');
const CURSOR = new Date('2026-09-06T00:00:00.000Z');

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const STAGE = idFromLastByte(2);

interface World {
  readonly files: MemoryRecordFiles;
  readonly deps: TaskMutationDependencies;
  /**
   * Three tasks whose three orders are three different permutations:
   * queue = Alpha, Beta, Gamma; stage = Beta, Gamma, Alpha; chronology = Alpha, Gamma, Beta.
   */
  readonly alpha: Task;
  readonly beta: Task;
  readonly gamma: Task;
  state(): Promise<ProximaState>;
  taskNamed(name: string): Promise<Task>;
  fileNames(): Promise<readonly string[]>;
  revisionMap(): Promise<Record<string, string>>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  await recovery.load();
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: { next: (prefix = 'id') => `${prefix}-request` },
  });

  let nextId = 40;
  const deps: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };

  const project: CanonicalProjectRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Scoped' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
  const stage = {
    ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id: STAGE, name: 'Design' }),
    projectId: PROJECT,
  } as CanonicalRecordV2;
  expect((await store.createIfAbsent(project as CanonicalRecordV2)).ok).toBe(true);
  expect((await store.createIfAbsent(stage)).ok).toBe(true);

  const source = recordStoreStateSource(store);
  const seed = async (name: string, executionOrder: number, workflowOrder: number, startDate: string): Promise<Task> => {
    const created = await createTask(deps, {
      name,
      projectId: PROJECT,
      executionState: 'backlog',
      executionOrder,
      workflowStageId: STAGE,
      workflowOrder,
      startDate,
      deadline: startDate,
    });
    if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
    const state = (await source.load()).state;
    const found = state.tasks.find((task) => task.id === created.recordId);
    if (found === undefined) throw new Error(`${name} is not in the projection`);
    return found;
  };

  const alpha = await seed('Alpha', 0, 2, '2026-09-10T09:00:00.000Z');
  const beta = await seed('Beta', 1, 0, '2026-09-20T09:00:00.000Z');
  const gamma = await seed('Gamma', 2, 1, '2026-09-15T09:00:00.000Z');

  return {
    files,
    deps,
    alpha,
    beta,
    gamma,
    state: async () => (await source.load()).state,
    taskNamed: async (name) => {
      const state = (await source.load()).state;
      const found = state.tasks.find((task) => task.name === name);
      if (found === undefined) throw new Error(`${name} is not in the projection`);
      return found;
    },
    fileNames: async () => await files.listRecordFiles(),
    revisionMap: async () => {
      const map: Record<string, string> = {};
      for (const fileName of await files.listRecordFiles()) {
        map[fileName] = (await files.readRecordFile(fileName as RecordStoreFileName))!.revision;
      }
      return map;
    },
  };
}

/** The card ids a project-board column drew, in the order it drew them. */
function boardColumnCards(html: string, status: string): string[] {
  const start = html.indexOf(`data-project-board-status-column="${status}"`);
  if (start < 0) return [];
  const next = html.indexOf('data-project-board-status-column="', start + 1);
  const section = html.slice(start, next < 0 ? html.length : next);
  return [...section.matchAll(/data-project-board-task-id="([^"]+)"/g)].map((match) => match[1]!);
}

/** The card ids a workflow stage column drew, in the order it drew them. */
function workflowStageCards(html: string, stageId: string): string[] {
  const start = html.indexOf(`data-project-workflow-stage-column="${stageId}"`);
  if (start < 0) return [];
  const next = html.indexOf('data-project-workflow-stage-column="', start + 1);
  const section = html.slice(start, next < 0 ? html.length : next);
  return [...section.matchAll(/data-project-workflow-task-id="([^"]+)"/g)].map((match) => match[1]!);
}

/** Every surface's own answer to "in what order", read out of what it draws. */
async function orders(w: World, state?: ProximaState): Promise<{
  readonly board: string[];
  readonly backlog: string[];
  readonly workflowBoard: string[];
  readonly gantt: string[];
}> {
  const current = state ?? await w.state();
  const project = current.projects[0]!;
  return {
    board: boardColumnCards(renderProjectTaskBoard(current, project), 'backlog'),
    backlog: projectBacklog(current, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: project.id }).rows.map((row) => row.taskId),
    workflowBoard: workflowStageCards(renderProjectWorkflowBoard(current, project), STAGE),
    gantt: timelineGanttProjection(current.tasks, CURSOR, NOW).map((entry) => entry.taskId),
  };
}

describe('scoped ordering', () => {
  it('draws each scope from its own rule, so three surfaces honestly disagree', async () => {
    const w = await world();
    const drawn = await orders(w);

    // The execution scope: the project Board and the Backlog both read orderIndex, so they agree.
    expect(drawn.board).toEqual([w.alpha.id, w.beta.id, w.gamma.id]);
    expect(drawn.backlog).toEqual([w.alpha.id, w.beta.id, w.gamma.id]);
    // The workflow scope reads workflowOrder - a different permutation of the same three tasks.
    expect(drawn.workflowBoard).toEqual([w.beta.id, w.gamma.id, w.alpha.id]);
    // The Gantt draws chronology, which is neither: Alpha is earliest, Beta latest.
    expect(drawn.gantt).toEqual([w.alpha.id, w.gamma.id, w.beta.id]);

    // Read from the records rather than from a surface: the two durable fields genuinely disagree.
    const alpha = await w.taskNamed('Alpha');
    expect(alpha.orderIndex).toBe(0);
    expect(alpha.workflowOrder).toBe(2);
    const beta = await w.taskNamed('Beta');
    expect(beta.orderIndex).toBe(1);
    expect(beta.workflowOrder).toBe(0);
    const gamma = await w.taskNamed('Gamma');
    expect(gamma.orderIndex).toBe(2);
    expect(gamma.workflowOrder).toBe(1);
  });

  it('moves one durable scope without moving the other, or the surface that draws it', async () => {
    const w = await world();
    const before = await orders(w);

    // Alpha goes to the end of the queue. That is one mutation of one field.
    const moved = await updateTask(w.deps, {
      taskId: w.alpha.id as OpaqueRecordId,
      expectedRevision: (await w.taskNamed('Alpha')).source.revision,
      mutations: [{ kind: 'execution-order', value: 9 }],
    });
    expect(moved.ok).toBe(true);

    const after = await orders(w);
    // The execution scope moved: both surfaces that draw it follow, and they still agree.
    expect(after.board).toEqual([w.beta.id, w.gamma.id, w.alpha.id]);
    expect(after.backlog).toEqual([w.beta.id, w.gamma.id, w.alpha.id]);
    // The workflow scope did not move - asserted on the stored value, not only on the rendering - and
    // neither did chronology, so the Gantt draws what it drew.
    expect((await w.taskNamed('Alpha')).workflowOrder).toBe(2);
    expect(after.workflowBoard).toEqual(before.workflowBoard);
    expect(after.gantt).toEqual(before.gantt);

    // The mirror image: a workflow reorder moves only the workflow scope.
    const reordered = await updateTask(w.deps, {
      taskId: w.alpha.id as OpaqueRecordId,
      expectedRevision: (await w.taskNamed('Alpha')).source.revision,
      mutations: [{ kind: 'workflow-order', value: 0 }],
    });
    expect(reordered.ok).toBe(true);

    const last = await orders(w);
    expect((await w.taskNamed('Alpha')).orderIndex).toBe(9);
    expect(last.board).toEqual(after.board);
    // Alpha and Beta now hold the same workflow position, so the tie is broken by id - the canonical
    // comparator's own rule rather than a surface's convenience.
    expect(last.workflowBoard).toEqual([w.alpha.id, w.beta.id, w.gamma.id]);
    expect(last.gantt).toEqual(before.gantt);
  });

  it('keeps the third scope out of the records entirely, which is what local state means', async () => {
    const w = await world();
    const beforeFiles = await w.fileNames();
    const beforeRevisions = await w.revisionMap();
    const before = await orders(w);

    // The local layout is a list of ids that lives in the reader's session, and the helper is pure.
    const rows: readonly OpaqueRecordId[] = [w.alpha.id as OpaqueRecordId, w.beta.id as OpaqueRecordId, w.gamma.id as OpaqueRecordId];
    const placed = placeCanonicalGanttRow(rows, w.gamma.id as OpaqueRecordId, 0);
    expect(placed).toEqual([w.gamma.id, w.alpha.id, w.beta.id]);
    expect(rows).toEqual([w.alpha.id, w.beta.id, w.gamma.id]);

    // Nothing durable changed: the same files at the same revisions, and every surface draws what it drew.
    expect(await w.fileNames()).toEqual(beforeFiles);
    expect(await w.revisionMap()).toEqual(beforeRevisions);
    expect(await orders(w)).toEqual(before);

    // The decision is a fact in the domain rather than a convention in a renderer, and it says local state.
    expect(GANTT_ROW_PLACEMENT_CATEGORY).toBe('local-state');
    // No record field carries a row position at all, so a surface cannot have read one.
    const task = await w.taskNamed('Alpha');
    expect(Object.keys(task)).not.toContain('rowIndex');
    expect(Object.keys(task)).not.toContain('timelineRow');
  });
});
