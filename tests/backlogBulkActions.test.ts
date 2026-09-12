// @vitest-environment happy-dom
/**
 * The Backlog's bulk controls: when they may act, what they report, and that the report is the
 * report.
 *
 * Stage 10's last box is that a bulk complete from the UI and from the agent produce the same
 * results. The two callers meet at one sequence, so the case that closes it drives the selection the
 * way the Backlog does — through its own control helpers — takes exactly the ids the UI would
 * submit, and compares what comes back with a directly submitted call over an identical world.
 *
 * The rendering cases are about the other half: a control that cannot write says so where it is, and
 * a report is drawn per entity rather than summarised into a count.
 */
import { describe, expect, it } from 'vitest';
import { applyBacklogControl, toggleBacklogSelection } from '../src/app/backlogControls.js';
import { EMPTY_BACKLOG_VIEW, projectBacklog, type BacklogViewState } from '../src/app/backlogView.js';
import { bulkCompleteTasks, type BulkTaskActionReport } from '../src/app/bulkTaskActions.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { Project, ProximaState } from '../src/domain/types.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  bindProjectBacklogInteractions,
  EMPTY_PROJECT_BACKLOG_VIEW,
  PROJECT_BACKLOG_WRITE_REFUSAL,
  renderProjectBacklog,
  type ProjectBacklogHandlers,
  type ProjectBacklogViewState,
} from '../src/browser/projectBacklog.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T09:00:00+07:00';

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

const PROJECT = idFromLastByte(111);

function projectRecord(id: OpaqueRecordId): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function reportFor(status: BulkTaskActionReport['status'], entities: BulkTaskActionReport['entities']): BulkTaskActionReport {
  return {
    schemaVersion: 1,
    action: 'task.bulk.complete',
    status,
    // Fixed rather than minted: this is a report the projection is handed to draw, not a run being executed.
    requestId: 'semantic-request-test',
    requested: entities.length,
    accepted: entities.filter((entity) => entity.ok).length,
    refused: entities.filter((entity) => !entity.ok).length,
    entities,
    refreshed: true,
  };
}

const quietHandlers: ProjectBacklogHandlers = {
  openTask: () => undefined,
  closeTask: () => undefined,
  startDrag: () => undefined,
  previewMove: () => undefined,
  refuseMove: () => undefined,
  clearDrag: () => undefined,
  setSearch: () => undefined,
  addFilter: () => undefined,
  removeFilter: () => undefined,
  sortBy: () => undefined,
  clearSort: () => undefined,
  clearQuery: () => undefined,
  toggleSelection: () => undefined,
  selectAllVisible: () => undefined,
  clearSelection: () => undefined,
  openTemplate: () => undefined,
  closeTemplate: () => undefined,
  setTemplateText: () => undefined,
  resizeColumn: () => undefined,
  editTask: () => undefined,
  cancelTaskEdit: () => undefined,
  bulkComplete: () => undefined,
  bulkDelete: () => undefined,
};

async function world(seedOffset: number) {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = seedOffset;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);
  const source = recordStoreStateSource(store);
  const read = async (): Promise<ProximaState> => (await source.load()).state;

  return {
    deps,
    state: read,
    project: async (): Promise<Project> => (await read()).projects[0]!,
    seed: async (name: string) => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: 'backlog', executionOrder: 0 });
      if (!created.ok) throw new Error(`seeding ${name} failed: ${created.reason}`);
      return created.recordId;
    },
    complete: async (taskIds: readonly string[]): Promise<BulkTaskActionReport> => await bulkCompleteTasks(
      {
        state: await read(),
        writes: async () => ({
          updateTask: (input) => updateTask(deps, input),
          deleteTask: async () => { throw new Error('not used'); },
        }),
        unavailableReason: () => null,
        refresh: async () => null,
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskIds },
    ),
  };
}

describe('Stage 10 Backlog bulk controls', () => {
  it('offers both controls exactly when this run may write, and says so where they are when it may not', async () => {
    const app = await world(1100);
    await app.seed('Marked');
    const state = await app.state();
    const project = await app.project();
    const marked: ProjectBacklogViewState = { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: PROJECT, selectedTaskIds: [state.tasks[0]!.id], bulkWriteRefusal: null };

    document.body.innerHTML = renderProjectBacklog(state, project, marked);
    const complete = document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-complete"]')!;
    const remove = document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-delete"]')!;
    expect(complete.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(complete.getAttribute('data-project-backlog-write-refusal')).toBeNull();
    expect(document.querySelector('[data-project-backlog-bulk-report]')).toBeNull();

    // With no write path the controls go back to being typed-unavailable, and they say why.
    document.body.innerHTML = renderProjectBacklog(state, project, { ...marked, bulkWriteRefusal: PROJECT_BACKLOG_WRITE_REFUSAL });
    const refused = document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-complete"]')!;
    expect(refused.disabled).toBe(true);
    expect(refused.getAttribute('data-project-backlog-write-refusal')).toBe(PROJECT_BACKLOG_WRITE_REFUSAL);
    expect(document.querySelector('[data-project-backlog-bulk]')!.textContent).toContain('No task was changed');

    // And with nothing marked there is nothing to act on, even when writing is possible.
    document.body.innerHTML = renderProjectBacklog(state, project, { ...marked, selectedTaskIds: [] });
    expect(document.querySelector<HTMLButtonElement>('[data-c1-key="project-backlog-bulk-complete"]')!.disabled).toBe(true);
  });

  it('reports a click on either control through the real binder, and nothing from a disabled one', async () => {
    const app = await world(1200);
    await app.seed('Marked');
    const state = await app.state();
    const project = await app.project();
    const clicks: string[] = [];
    let view: ProjectBacklogViewState = { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: PROJECT, selectedTaskIds: [state.tasks[0]!.id], bulkWriteRefusal: null };
    const draw = () => { document.body.innerHTML = renderProjectBacklog(state, project, view); };

    draw();
    bindProjectBacklogInteractions(document.body, {
      ...quietHandlers,
      bulkComplete: () => { clicks.push('complete'); },
      bulkDelete: () => { clicks.push('delete'); },
    });

    createInteractionHarness(document).click('project-backlog-bulk-complete');
    createInteractionHarness(document).click('project-backlog-bulk-delete');
    expect(clicks).toEqual(['complete', 'delete']);

    // A disabled control reports nothing: the binder is not the thing that decides, the write path is.
    view = { ...view, bulkWriteRefusal: PROJECT_BACKLOG_WRITE_REFUSAL };
    draw();
    bindProjectBacklogInteractions(document.body, {
      ...quietHandlers,
      bulkComplete: () => { clicks.push('complete-again'); },
      bulkDelete: () => { clicks.push('delete-again'); },
    });
    createInteractionHarness(document).click('project-backlog-bulk-complete');
    expect(clicks).toEqual(['complete', 'delete']);
  });

  it('draws the last run per entity, with a summary that cannot overstate it', async () => {
    const app = await world(1300);
    const first = await app.seed('First');
    const second = await app.seed('Second');
    const state = await app.state();
    const project = await app.project();

    const partial = reportFor('partial', [
      { taskId: first, ok: true, revision: `${first}@2` },
      { taskId: second, ok: false, reason: 'stale-revision', detail: 'another writer changed this task first' },
    ]);
    document.body.innerHTML = renderProjectBacklog(state, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: PROJECT, bulkReport: partial });

    const summary = document.querySelector<HTMLElement>('[data-project-backlog-bulk-report]')!;
    expect(summary.dataset.projectBacklogBulkReport).toBe('partial');
    expect(summary.dataset.projectBacklogBulkAccepted).toBe('1');
    expect(summary.dataset.projectBacklogBulkRefused).toBe('1');
    expect(summary.dataset.projectBacklogBulkRequested).toBe('2');
    // One row per entity, so a refused member is visible rather than averaged away.
    const rows = Array.from(summary.querySelectorAll<HTMLElement>('[data-project-backlog-bulk-entity]'));
    expect(rows.map((row) => [row.dataset.projectBacklogBulkEntity, row.dataset.projectBacklogBulkOutcome]))
      .toEqual([[first, 'accepted'], [second, 'stale-revision']]);
    expect(rows[1]!.textContent).toContain('another writer changed this task first');

    // A report belongs to the project it was made for.
    document.body.innerHTML = renderProjectBacklog(state, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: 'another-project', bulkReport: partial });
    expect(document.querySelector('[data-project-backlog-bulk-report]')).toBeNull();
  });

  it('produces the same results whether the selection comes from the Backlog or is submitted directly', async () => {
    const ui = await world(1400);
    const agent = await world(1500);
    const uiFirst = await ui.seed('One');
    const uiSecond = await ui.seed('Two');
    const agentFirst = await agent.seed('One');
    const agentSecond = await agent.seed('Two');

    // The UI's caller: the marks the Backlog itself would hold, taken through its own helpers.
    let view: BacklogViewState = { ...EMPTY_BACKLOG_VIEW, projectId: PROJECT };
    view = { ...view, selectedTaskIds: toggleBacklogSelection(view.selectedTaskIds, uiFirst) };
    view = { ...view, selectedTaskIds: toggleBacklogSelection(view.selectedTaskIds, uiSecond) };
    const markedFromTheUi = [...view.selectedTaskIds];
    expect(markedFromTheUi).toEqual([uiFirst, uiSecond]);
    // And the projection the buttons are drawn from agrees about what is marked.
    const uiProjection = projectBacklog(await ui.state(), await ui.project(), view);
    expect(uiProjection.selectedCount).toBe(2);

    const fromUi = await ui.complete(markedFromTheUi);
    const fromAgent = await agent.complete([agentFirst, agentSecond]);

    // Same operation, same words, same counts: the ids differ because the worlds do, and that is the
    // only difference a comparison finds.
    expect(fromUi.status).toBe(fromAgent.status);
    expect({ requested: fromUi.requested, accepted: fromUi.accepted, refused: fromUi.refused })
      .toEqual({ requested: fromAgent.requested, accepted: fromAgent.accepted, refused: fromAgent.refused });
    expect(fromUi.entities.map((entity) => entity.ok)).toEqual(fromAgent.entities.map((entity) => entity.ok));
    expect((await ui.state()).tasks.every((task) => task.status === 'finished')).toBe(true);
    expect((await agent.state()).tasks.every((task) => task.status === 'finished')).toBe(true);
  });

  it('leaves the query alone when a bulk run happens, and can be driven over a filtered selection', async () => {
    const app = await world(1600);
    const first = await app.seed('Alpha');
    await app.seed('Hidden one');
    const state = await app.state();

    // A selection made under a query is still a selection: the marked id is what a bulk run covers,
    // and the query is how the reader is looking at the table rather than what the action sees.
    let view: BacklogViewState = { ...EMPTY_BACKLOG_VIEW, projectId: PROJECT };
    view = { ...view, query: applyBacklogControl(view.query, { kind: 'set-search', search: 'Hidden' }) };
    view = { ...view, selectedTaskIds: toggleBacklogSelection(view.selectedTaskIds, first) };
    const projection = projectBacklog(state, await app.project(), view);
    expect(projection.rows.map((row) => row.name)).toEqual(['Hidden one']);
    expect(projection.selectedCount).toBe(0);
    expect(projection.hiddenSelectedCount).toBe(1);

    const report = await app.complete([...view.selectedTaskIds]);
    expect(report).toMatchObject({ status: 'accepted', requested: 1, accepted: 1 });
    expect((await app.state()).tasks.find((task) => task.id === first)?.status).toBe('finished');
  });
});
