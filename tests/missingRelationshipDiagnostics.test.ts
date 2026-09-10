import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

const EXISTING_PROJECT_ID = 'existing-project';
const TASK_PROJECT_ID = 'missing-task-project';
const EVENT_PROJECT_ID = 'missing-schedule-project';
const TASK_ID = 'orphan-task';
const EVENT_ID = 'orphan-event';

const TASK_PATH = `Proxima/tasks/${TASK_ID}.md`;
const EVENT_PATH = `Proxima/events/${EVENT_ID}.md`;

const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'test-sha',
  buildMode: 'fixture',
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: '1',
  fixtureHash: 'fixture-hash',
  lockfileHash: 'lock-hash',
  fixedClock: '2026-09-06T12:00:00.000Z',
};

function projectDocument(id: string, projectType: 'task' | 'schedule'): string {
  return `---\nid: ${id}\nname: ${id}\nprojectType: ${projectType}\n---\n`;
}

function taskDocument(projectId = TASK_PROJECT_ID, name = 'Orphan task'): string {
  return `---\nid: ${TASK_ID}\nname: ${name}\nproject: ${projectId}\nstatus: running\ncreatedAt: 2026-09-06T10:00:00.000Z\ndeadline: 2026-09-07T12:00:00.000Z\n---\n`;
}

function eventDocument(projectId = EVENT_PROJECT_ID): string {
  return `---\nid: ${EVENT_ID}\nname: Orphan event\nproject: ${projectId}\ncreatedAt: 2026-09-06T10:00:00.000Z\nstartDate: 2026-09-07T09:00:00.000Z\ndeadline: 2026-09-07T10:00:00.000Z\n---\n`;
}

function orphanVault() {
  return createMemoryVault({
    [`Proxima/projects/${EXISTING_PROJECT_ID}.md`]: projectDocument(EXISTING_PROJECT_ID, 'task'),
    [TASK_PATH]: taskDocument(),
    [EVENT_PATH]: eventDocument(),
  });
}

describe('Stage 6 slice 11 missing-relationship diagnostics', () => {
  it('keeps orphaned records visible in state and emits one structured missing-project warning per broken relationship', async () => {
    const loaded = await loadVaultState(orphanVault());
    expect(isDiagnosticCode('missing-project')).toBe(true);
    expect(loaded.state.tasks.find((task) => task.id === TASK_ID)).toMatchObject({ id: TASK_ID, projectId: TASK_PROJECT_ID, source: { path: TASK_PATH } });
    expect(loaded.state.events.find((event) => event.id === EVENT_ID)).toMatchObject({ id: EVENT_ID, projectId: EVENT_PROJECT_ID, source: { path: EVENT_PATH } });
    const missing = loaded.problems.filter((problem) => problem.code === 'missing-project');
    expect(missing).toHaveLength(2);
    expect(missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-project', severity: 'warning', kind: 'task', id: TASK_ID, path: TASK_PATH, detail: expect.stringContaining(TASK_PROJECT_ID) }),
      expect.objectContaining({ code: 'missing-project', severity: 'warning', kind: 'event', id: EVENT_ID, path: EVENT_PATH, detail: expect.stringContaining(EVENT_PROJECT_ID) }),
    ]));
  });

  it('preserves missing-project through read-only diagnostics while refusing to misroute orphaned records into project surfaces', async () => {
    const vault = orphanVault();
    const loaded = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial: loaded });
    const projection = createReadOnlyProjection(controller.snapshot());
    expect(projection.health.problemCodes).toContain('missing-project');
    expect(projection.problems.filter((problem) => problem.code === 'missing-project')).toHaveLength(2);
    expect(projection.state.tasks.some((task) => task.id === TASK_ID && task.projectId === TASK_PROJECT_ID)).toBe(true);
    expect(projection.state.events.some((event) => event.id === EVENT_ID && event.projectId === EVENT_PROJECT_ID)).toBe(true);
    const dispatcher = createActionDispatcher({ state: loaded.state, problems: loaded.problems, revisions: loaded.revisions, mode: 'fixture' });
    const inspection = createInspectionProjection(dispatcher.snapshot(), BUILD);
    expect(inspection.sourceHealth.problemCodes).toContain('missing-project');
    expect(inspection.loadProblems.filter((problem) => problem.code === 'missing-project')).toHaveLength(2);
    expect(inspection.board.tasks.some((task) => task.id === TASK_ID)).toBe(false);
    expect(inspection.calendar.events.some((event) => event.id === EVENT_ID)).toBe(false);
    expect(inspection.degraded).toEqual({ state: 'healthy', blockingProblemCount: 0 });
  });

  it('accepts an otherwise valid refreshed generation carrying a missing-project warning without pretending the relationship was repaired', async () => {
    const vault = orphanVault();
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial });
    vault.set(TASK_PATH, taskDocument(TASK_PROJECT_ID, 'Externally changed orphan'));
    const refreshed = await controller.refreshSource('external-signal');
    expect(refreshed).toMatchObject({ ok: true, outcome: 'changed', changed: true, snapshot: { sourceRevision: 2, lastSuccessfulRefreshRevision: 2, stale: false, refreshState: 'idle', lastRefreshProblemCode: null } });
    expect(refreshed.snapshot.load.state.tasks.find((task) => task.id === TASK_ID)).toMatchObject({ name: 'Externally changed orphan', projectId: TASK_PROJECT_ID });
    expect(refreshed.snapshot.load.problems.some((problem) => problem.code === 'missing-project' && problem.kind === 'task' && problem.id === TASK_ID)).toBe(true);
    expect(createReadOnlyProjection(refreshed.snapshot).health.problemCodes).toContain('missing-project');
  });

  it('observes an external relationship repair without rewriting either record and then routes both records normally', async () => {
    const vault = orphanVault();
    const initial = await loadVaultState(vault);
    const taskBefore = await vault.read(TASK_PATH);
    const eventBefore = await vault.read(EVENT_PATH);
    const controller = createRefreshController({ vault, initial });
    vault.set(`Proxima/projects/${TASK_PROJECT_ID}.md`, projectDocument(TASK_PROJECT_ID, 'task'));
    vault.set(`Proxima/projects/${EVENT_PROJECT_ID}.md`, projectDocument(EVENT_PROJECT_ID, 'schedule'));
    const repaired = await controller.refreshSource('manual');
    expect(repaired).toMatchObject({ ok: true, outcome: 'changed', changed: true, snapshot: { sourceRevision: 2, lastSuccessfulRefreshRevision: 2, stale: false, refreshState: 'idle', lastRefreshProblemCode: null } });
    expect(repaired.snapshot.load.problems.some((problem) => problem.code === 'missing-project')).toBe(false);
    expect(repaired.snapshot.load.state.tasks.find((task) => task.id === TASK_ID)?.projectId).toBe(TASK_PROJECT_ID);
    expect(repaired.snapshot.load.state.events.find((event) => event.id === EVENT_ID)?.projectId).toBe(EVENT_PROJECT_ID);
    const dispatcher = createActionDispatcher({ state: repaired.snapshot.load.state, problems: repaired.snapshot.load.problems, revisions: repaired.snapshot.load.revisions, mode: 'fixture' });
    const inspection = createInspectionProjection(dispatcher.snapshot(), BUILD);
    expect(inspection.board.tasks.some((task) => task.id === TASK_ID)).toBe(true);
    expect(inspection.calendar.events.some((event) => event.id === EVENT_ID)).toBe(true);
    expect((await vault.read(TASK_PATH)).text).toBe(taskBefore.text);
    expect((await vault.read(EVENT_PATH)).text).toBe(eventBefore.text);
  });
});
