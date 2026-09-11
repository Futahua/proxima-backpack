// @vitest-environment happy-dom
//
// HARD GATE C item 5: the UI must not care whether state came from legacy Markdown or from
// the Proxima record store. This file builds a small canonical world, projects it, and then
// renders the real surfaces from it — because "the projection exists" is not the claim;
// "the surfaces render it" is.
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection, isInspectionProjection } from '../src/app/inspection.js';
import {
  EXECUTION_STATE_STATUSES,
  executionStateOf,
  isRecordStoreState,
  projectRecordState,
  RECORD_STATE_PROJECTION_VERSION,
  type RecordStateProjectionGap,
} from '../src/app/recordStateProjection.js';
import { loadRecordStoreState } from '../src/app/recordStoreStateLoad.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { renderProjectsHub } from '../src/browser/projectsHub.js';
import { EMPTY_PROJECT_BACKLOG_VIEW } from '../src/browser/projectBacklog.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import {
  type CanonicalEventRecordV2,
  type CanonicalProjectRecordV2,
  type CanonicalRecordV2,
  type CanonicalTaskRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import { canonicalOrderPosition } from '../src/domain/canonicalOrdering.js';
import {
  defineCanonicalPropertySchema,
  opaqueSchemaOptionIdFromRandomBytes,
  parseOpaqueSchemaOptionId,
  type CanonicalPropertySchemaRecord,
} from '../src/domain/canonicalSchema.js';
import { defineCanonicalRelationValue } from '../src/domain/canonicalRelation.js';
import { parseOpaqueExternalArtifactId } from '../src/domain/canonicalArtifactAssociation.js';
import type { CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
import { recordOriginOf } from '../src/domain/records.js';
import type { RecordStoreObservation } from '../src/ports/recordStore.js';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const OTHER_PROJECT = idFromLastByte(2);
const STAGE = idFromLastByte(3);
const EFFORT = idFromLastByte(4);
const PRIORITY = idFromLastByte(5);
const OPTION_HIGH = opaqueSchemaOptionIdFromRandomBytes((() => {
  const bytes = new Uint8Array(16);
  bytes[15] = 1;
  return bytes;
})());
const TASK_RUNNING = idFromLastByte(10);
const TASK_BACKLOG = idFromLastByte(11);
const EVENT = idFromLastByte(20);

const NOW = new Date('2026-09-06T12:00:00.000Z');

function observation<T extends CanonicalRecordV2>(record: T, revision = `${record.id}@1`): RecordStoreObservation<T> {
  return { record, id: record.id, kind: record.kind, observedRevision: revision };
}

function prioritySchema(): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({ kind: 'schema', id: PRIORITY, name: 'Priority' }),
    definition: {
      type: 'select',
      options: [{ id: OPTION_HIGH, label: 'High' }],
    },
  });
}

function effortSchema(): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({ kind: 'schema', id: EFFORT, name: 'Effort' }),
    definition: { type: 'number' },
  });
}

function project(id: OpaqueRecordId, name: string, status: 'active' | 'archived' = 'active'): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name }),
    description: `${name} description`,
    createdAt: '2026-08-01T00:00:00.000Z',
    status,
    archivedAt: status === 'archived' ? '2026-08-15T00:00:00.000Z' : null,
    artifactBindings: [],
  };
}

function task(input: {
  id: OpaqueRecordId;
  name: string;
  projectId: OpaqueRecordId | null;
  executionState: 'backlog' | 'running' | 'finished';
  executionOrder: number;
  deadline: string | null;
}): CanonicalTaskRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'task', id: input.id, name: input.name }),
    projectId: input.projectId,
    executionState: input.executionState,
    workflowStageId: STAGE,
    executionOrder: canonicalOrderPosition(input.executionOrder),
    workflowOrder: canonicalOrderPosition(1),
    description: `${input.name} description`,
    weight: 2,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: 90,
    isCompleted: input.executionState === 'finished',
    createdAt: '2026-08-01T00:00:00.000Z',
    startDate: null,
    deadline: input.deadline,
    properties: {
      [EFFORT]: { type: 'number', value: 3 },
      [PRIORITY]: { type: 'select', optionId: OPTION_HIGH },
    },
    recurrence: null,
  };
}

function event(id: OpaqueRecordId, name: string, projectId: OpaqueRecordId | null): CanonicalEventRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'event', id, name }),
    startDate: '2026-09-08T10:00:00.000Z',
    deadline: '2026-09-08T11:00:00.000Z',
    description: `${name} description`,
    projectId,
    createdAt: '2026-08-01T00:00:00.000Z',
    isCompleted: false,
    properties: {},
    recurrence: null,
  };
}

function stage(id: OpaqueRecordId, projectId: OpaqueRecordId, name: string): CanonicalWorkflowStageStateRecord {
  return {
    ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id, name }),
    projectId,
  };
}

function world(): RecordStoreObservation<CanonicalRecordV2>[] {
  return [
    observation(project(PROJECT, 'Backpack Port')),
    observation(project(OTHER_PROJECT, 'Studio', 'archived')),
    observation(stage(STAGE, PROJECT, 'In review')),
    observation(prioritySchema()),
    observation(effortSchema()),
    observation(task({ id: TASK_RUNNING, name: 'Running task', projectId: PROJECT, executionState: 'running', executionOrder: 2, deadline: '2026-09-09T09:00:00.000Z' })),
    observation(task({ id: TASK_BACKLOG, name: 'Backlog task', projectId: PROJECT, executionState: 'backlog', executionOrder: 1, deadline: null })),
    observation(event(EVENT, 'Reviewer gate', PROJECT)),
  ];
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Stage 44 canonical records to the readable world', () => {
  it('projects every kind into a state the existing surfaces render', () => {
    const { state, report } = projectRecordState(world());

    expect(report.schemaVersion).toBe(RECORD_STATE_PROJECTION_VERSION);
    expect(report.source).toBe('proxima-record-store');
    expect(report.consumed).toEqual({ project: 2, task: 2, event: 1, schema: 2, 'workflow-stage': 1 });
    expect(state.projects.map((candidate) => candidate.id)).toEqual([PROJECT, OTHER_PROJECT]);
    expect(state.tasks.map((candidate) => candidate.id)).toEqual([TASK_RUNNING, TASK_BACKLOG]);
    expect(state.events.map((candidate) => candidate.id)).toEqual([EVENT]);
    expect(state.statuses).toEqual([...EXECUTION_STATE_STATUSES]);
    expect(state.taskSchema.map((schema) => [schema.name, schema.type])).toEqual([
      ['Effort', 'number'],
      ['Priority', 'select'],
    ]);

    // The two surfaces that group by status render the projected execution states, and the
    // Hub card is built from the projected project.
    document.body.innerHTML = renderProjectTaskBoard(state, state.projects[0]!);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-board-status-column]'))
      .map((column) => column.dataset.projectBoardStatusColumn)).toEqual(['backlog', 'running', 'finished']);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-board-status-column="running"] [data-project-board-task-id]'))
      .map((card) => card.dataset.projectBoardTaskId)).toEqual([TASK_RUNNING]);

    document.body.innerHTML = renderProjectBacklog(state, state.projects[0]!, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: PROJECT });
    const backlogHtml = document.body.innerHTML;
    expect(backlogHtml).toContain('Running task');
    expect(backlogHtml).toContain('2026-09-09T09:00:00.000Z');

    document.body.innerHTML = renderProjectsHub({ state, selection: 'all', filter: 'active', workspaceTab: 'notes', now: NOW });
    expect(document.querySelector(`[data-c1-key="project-hub-card-${PROJECT}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-c1-key="project-hub-card-${OTHER_PROJECT}"]`)).toBeNull();
  });

  it('carries canonical values into the compatibility shape without losing what it can hold', () => {
    const { state } = projectRecordState(world());
    const running = state.tasks.find((task) => task.id === TASK_RUNNING)!;

    // Identity is the opaque record id and the provenance says where it came from, so
    // inspection can name the record store instead of pretending this is Markdown.
    expect(running.source).toEqual({
      path: TASK_RUNNING,
      revision: `${TASK_RUNNING}@1`,
      kind: 'task',
      idOrigin: 'record-store',
    });
    expect(recordOriginOf(running.source)).toBe('record-store');
    expect(isRecordStoreState(state)).toBe(true);

    // A number stays a number and a select is named, not left as a raw option id.
    expect(running.properties[EFFORT]).toBe(3);
    expect(running.properties[PRIORITY]).toBe('High');
    expect(running.orderIndex).toBe(2);
    expect(running.status).toBe('running');
    expect(executionStateOf(running)).toBe('running');
    expect(running.weight).toBe(2);
    expect(running.maxDuration).toBe(90);

    const relation = projectRecordState([
      observation(task({
        id: TASK_RUNNING,
        name: 'Related task',
        projectId: PROJECT,
        executionState: 'running',
        executionOrder: 1,
        deadline: null,
      })),
    ]);
    const withRelation = relation.state.tasks[0]!;
    expect(withRelation.properties[EFFORT]).toBe(3);

    // A relation keeps identity: a single target is the id, several are ids in order.
    const single = defineCanonicalRelationValue({ relationSchemaId: EFFORT, targetRecordIds: [EVENT] });
    expect(single.targetRecordIds).toEqual([EVENT]);
  });

  it('reports what the compatibility shape cannot carry instead of dropping it', () => {
    const { state, report } = projectRecordState(world());
    const reasons = report.gaps.map((gap) => gap.reason);

    // A workflow stage has no slot in the readable world, and A2 is why: the board's columns
    // are execution states, and the stage is an independent dimension.
    expect(reasons).toContain('workflow-stage-has-no-legacy-slot');
    const stageGap = report.gaps.find((gap) => gap.kind === 'workflow-stage')!;
    expect(stageGap.id).toBe(STAGE);
    expect(stageGap.detail).toContain('independent');

    // An option with no schema record to name it is reported, and the raw id is kept rather
    // than a label being invented for it.
    const unknownOption = parseOpaqueSchemaOptionId('pxo_000000000000000000000000000000ff');
    const orphan: RecordStoreObservation<CanonicalRecordV2>[] = [
      observation({
        ...task({ id: TASK_BACKLOG, name: 'Orphan option', projectId: PROJECT, executionState: 'backlog', executionOrder: 1, deadline: null }),
        properties: { [PRIORITY]: { type: 'select', optionId: unknownOption } },
      }),
    ];
    const orphanProjection = projectRecordState(orphan);
    const orphanGap: RecordStateProjectionGap | undefined = orphanProjection.report.gaps
      .find((gap) => gap.reason === 'property-option-not-in-schema');
    expect(orphanGap).toBeDefined();
    expect(orphanProjection.state.tasks[0]?.properties[PRIORITY]).toBe(unknownOption);

    // A project's artifact bindings are explicit references whose locators are not records,
    // so they are reported rather than turned into invented folders.
    const bound = projectRecordState([
      observation({
        ...project(PROJECT, 'Bound'),
        artifactBindings: [{ role: 'notes-root', artifactId: parseOpaqueExternalArtifactId('pxa_00000000000000000000000000000001') }],
      }),
    ]);
    expect(bound.state.projects[0]?.linkedFolders).toEqual([]);
    expect(bound.report.gaps.some((gap) => gap.reason === 'artifact-binding-not-resolvable-from-records')).toBe(true);

    // The legacy project label A4 removed is reconstructed from what the project holds, and
    // the archived project keeps its archived state and date.
    expect(state.projects[0]?.projectType).toBe('task');
    const eventsOnly = projectRecordState([
      observation(project(PROJECT, 'Events only')),
      observation(event(EVENT, 'Gate', PROJECT)),
    ]);
    expect(eventsOnly.state.projects[0]?.projectType).toBe('schedule');
    const archived = state.projects.find((project) => project.id === OTHER_PROJECT)!;
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe('2026-08-15T00:00:00.000Z');
    // No task and no event in the archived project, so there is nothing to call it but its
    // own default.
    expect(archived.projectType).toBe('task');
  });

  it('is deterministic, and reports the revisions a caller needs to notice change', () => {
    const first = projectRecordState(world());
    const second = projectRecordState([...world()].reverse());

    expect(second.state).toEqual(first.state);
    expect(second.report).toEqual(first.report);
    expect(first.report.revisions[TASK_RUNNING]).toBe(`${TASK_RUNNING}@1`);

    const changed = projectRecordState(world().map((entry) => (
      entry.id === TASK_RUNNING ? { ...entry, observedRevision: `${TASK_RUNNING}@2` } : entry
    )));
    expect(changed.report.revisions[TASK_RUNNING]).toBe(`${TASK_RUNNING}@2`);
    expect(changed.state.tasks.find((task) => task.id === TASK_RUNNING)?.source.revision).toBe(`${TASK_RUNNING}@2`);
  });

  it('loads the same world through the real record store, and the surfaces cannot tell the difference', async () => {
    // The store side: records written through the canonical boundary, read back through it.
    const files = new MemoryRecordFiles();
    const store = createCanonicalJsonRecordStore(files);
    for (const entry of world()) {
      const result = await store.createIfAbsent(entry.record);
      expect(result.ok).toBe(true);
    }

    const fromStore = await loadRecordStoreState(store);
    expect(fromStore.origin).toBe('record-store');
    expect(fromStore.state.tasks.map((task) => task.name)).toEqual(['Running task', 'Backlog task']);
    expect(Object.keys(fromStore.revisions)).toHaveLength(world().length);

    // The legacy side: the same world written as Markdown, read by the compatibility reader.
    const legacy = await loadVaultState(createMemoryVault({
      'Proxima/projects/port.md': [
        '---',
        'id: port',
        'name: Backpack Port',
        'status: active',
        'createdAt: 2026-08-01T00:00:00.000Z',
        '---',
        'Backpack Port description',
        '',
      ].join('\n'),
      'Proxima/tasks/running.md': [
        '---',
        'id: running',
        'name: Running task',
        'project: port',
        'status: running',
        'weight: 2',
        'orderIndex: 2',
        'maxDuration: 90',
        'isCompleted: false',
        'createdAt: 2026-08-01T00:00:00.000Z',
        'deadline: 2026-09-09T09:00:00.000Z',
        '---',
        'Running task description',
        '',
      ].join('\n'),
      'Proxima/tasks/backlog.md': [
        '---',
        'id: backlog',
        'name: Backlog task',
        'project: port',
        'status: backlog',
        'weight: 2',
        'orderIndex: 1',
        'isCompleted: false',
        'createdAt: 2026-08-01T00:00:00.000Z',
        '---',
        'Backlog task description',
        '',
      ].join('\n'),
    }));

    const boardFrom = (state: typeof fromStore.state): { columns: string[]; cards: Record<string, string[]> } => {
      document.body.innerHTML = renderProjectTaskBoard(state, state.projects[0]!);
      const columns = Array.from(document.querySelectorAll<HTMLElement>('[data-project-board-status-column]'))
        .map((column) => column.dataset.projectBoardStatusColumn ?? '');
      const cards: Record<string, string[]> = {};
      for (const column of columns) {
        cards[column] = Array.from(document.querySelectorAll<HTMLElement>(`[data-project-board-status-column="${column}"] [data-project-board-task-id]`))
          .map((card) => card.querySelector('strong')?.textContent ?? '');
      }
      return { columns, cards };
    };

    const storeBoard = boardFrom(fromStore.state);
    const legacyBoard = boardFrom(legacy.state);

    // The legacy reader's status vocabulary is the vault's, and its finished column is
    // called `review`; the record store's vocabulary is the canonical execution states and
    // calls it `finished`. Both draw the same cards in the same three Elastic columns, in the
    // same order, which is the claim: the board asks the state what it holds, not where the
    // state came from. A projection that borrowed the legacy word would be pretending the
    // store holds a vault's status.
    expect(storeBoard.columns).toEqual(['backlog', 'running', 'finished']);
    expect(legacyBoard.columns).toEqual(['backlog', 'running', 'review']);
    expect(Object.values(storeBoard.cards)).toEqual(Object.values(legacyBoard.cards));
    expect(storeBoard.cards.running).toEqual(['Running task']);
    expect(storeBoard.cards.backlog).toEqual(['Backlog task']);

    // And the provenance on the two sides says which is which, so inspection can too.
    expect(isRecordStoreState(fromStore.state)).toBe(true);
    expect(isRecordStoreState(legacy.state)).toBe(false);
    expect(recordOriginOf(fromStore.state.tasks[0]!.source)).toBe('record-store');
    expect(recordOriginOf(legacy.state.tasks[0]!.source)).toBe('legacy-markdown');

    // Reading the store twice, without a write, changes nothing.
    const again = await loadRecordStoreState(store);
    expect(again.state).toEqual(fromStore.state);
    expect(again.revisions).toEqual(fromStore.revisions);
  });

  it('lets inspection name the record store instead of pretending JSON records are Markdown', async () => {
    const files = new MemoryRecordFiles();
    const store = createCanonicalJsonRecordStore(files);
    for (const entry of world()) await store.createIfAbsent(entry.record);
    const loaded = await loadRecordStoreState(store);

    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: [],
      revisions: loaded.revisions,
      mode: 'fixture',
    });
    const inspection = createInspectionProjection(dispatcher.snapshot(), {
      proximaVersion: '0.1.0',
      gitSha: 'test',
      buildMode: 'fixture',
      domainSchemaVersion: '2',
      controlSchemaVersion: '1',
      fixtureSchemaVersion: '1',
      fixtureHash: 'test',
      lockfileHash: 'test',
      fixedClock: '2026-09-06T12:00:00.000Z',
    });

    // Provenance answers "where did this come from" with the record store, and the revision
    // it reports is the one the store observed — not a Markdown file revision, and not a
    // path in the creator's vault that does not exist.
    const project = inspection.projects.find((entry) => entry.id === PROJECT)!;
    expect(project.provenance.idOrigin).toBe('record-store');
    expect(project.provenance.sourceKind).toBe('project');
    expect(project.provenance.relativeSourcePath).toBe(PROJECT);
    expect(project.provenance.sourceRevision).toBe(loaded.revisions[PROJECT]);

    const task = inspection.board.tasks.find((entry) => entry.id === TASK_RUNNING)!;
    expect(task.provenance.idOrigin).toBe('record-store');
    expect(task.provenance.sourceRevision).toBe(loaded.revisions[TASK_RUNNING]);

    const event = inspection.calendar.events.find((entry) => entry.id === EVENT)!;
    expect(event.provenance.idOrigin).toBe('record-store');

    expect(inspection.recordRevisions.some((entry) => entry.id === TASK_RUNNING && entry.revision === loaded.revisions[TASK_RUNNING])).toBe(true);
    // The inspection snapshot is still a valid one, so nothing downstream has to special-case
    // a record-store origin.
    expect(isInspectionProjection(inspection)).toBe(true);
  });
});
