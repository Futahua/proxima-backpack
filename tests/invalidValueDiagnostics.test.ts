import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { isDiagnosticCode } from '../src/app/diagnostics.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createReadOnlyProjection } from '../src/app/readOnlyProjection.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

const PROJECT_PATH = 'Proxima/projects/project-a.md';
const TASK_PATH = 'Proxima/tasks/task-a.md';
const EVENT_PATH = 'Proxima/events/event-a.md';

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

const PROJECT = `---
id: project-a
name: Project A
projectType: task
---
`;

const VALID_TASK = `---
id: task-a
name: Task A
status: running
weight: 2
orderIndex: 1
fixedDuration: 30
createdAt: 2026-09-06T10:00:00.000Z
deadline: 2026-09-07T12:00:00.000Z
---
`;

const INVALID_TASK = `---
id: task-a
name: Task A
status: running
weight: -2
orderIndex: nope
fixedDuration: half-an-hour
createdAt: 2026-09-06T10:00:00.000Z
deadline: next tuesday
---
`;

const VALID_EVENT = `---
id: event-a
name: Event A
createdAt: 2026-09-06T10:00:00.000Z
startDate: 2026-09-07T09:00:00.000Z
deadline: 2026-09-07T10:00:00.000Z
---
`;

const INVALID_EVENT = `---
id: event-a
name: Event A
createdAt: 2026-09-06T10:00:00.000Z
startDate: not-a-date
---
`;

function validVault() {
  return createMemoryVault({
    [PROJECT_PATH]: PROJECT,
    [TASK_PATH]: VALID_TASK,
    [EVENT_PATH]: VALID_EVENT,
  });
}

function invalidVault() {
  return createMemoryVault({
    [PROJECT_PATH]: PROJECT,
    [TASK_PATH]: INVALID_TASK,
    [EVENT_PATH]: INVALID_EVENT,
  });
}

describe('Stage 6 slice 12 invalid date/number diagnostics', () => {
  it('maps invalid numeric and date fields to stable structured codes while substituting only safe established values', async () => {
    const loaded = await loadVaultState(invalidVault());

    expect(isDiagnosticCode('bad-number')).toBe(true);
    expect(isDiagnosticCode('bad-date')).toBe(true);

    const task = loaded.state.tasks.find(
      (candidate) => candidate.id === 'task-a',
    );
    expect(task).toMatchObject({
      id: 'task-a',
      weight: 1,
      orderIndex: 0,
      fixedDuration: null,
      deadline: null,
    });

    const event = loaded.state.events.find(
      (candidate) => candidate.id === 'event-a',
    );
    expect(event).toMatchObject({
      id: 'event-a',
      startDate: '',
      deadline: '',
    });

    const numbers = loaded.problems.filter(
      (problem) => problem.code === 'bad-number',
    );
    expect(numbers).toHaveLength(3);
    expect(numbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          kind: 'task',
          id: 'task-a',
          path: TASK_PATH,
          detail: expect.stringContaining('weight'),
        }),
        expect.objectContaining({
          severity: 'warning',
          kind: 'task',
          id: 'task-a',
          path: TASK_PATH,
          detail: expect.stringContaining('orderIndex'),
        }),
        expect.objectContaining({
          severity: 'warning',
          kind: 'task',
          id: 'task-a',
          path: TASK_PATH,
          detail: expect.stringContaining('fixedDuration'),
        }),
      ]),
    );

    const dates = loaded.problems.filter(
      (problem) => problem.code === 'bad-date',
    );
    expect(dates).toHaveLength(2);
    expect(dates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          kind: 'task',
          id: 'task-a',
          path: TASK_PATH,
          detail: expect.stringContaining('deadline'),
        }),
        expect.objectContaining({
          severity: 'warning',
          kind: 'event',
          id: 'event-a',
          path: EVENT_PATH,
          detail: expect.stringContaining('startDate'),
        }),
      ]),
    );
  });

  it('preserves bad-date and bad-number through read-only projection and inspection without exposing unsafe computational values', async () => {
    const vault = invalidVault();
    const loaded = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial: loaded,
    });

    const projection = createReadOnlyProjection(
      controller.snapshot(),
    );

    expect(projection.health.problemCodes)
      .toEqual(expect.arrayContaining(['bad-number', 'bad-date']));

    expect(
      projection.problems.filter(
        (problem) => problem.code === 'bad-number',
      ),
    ).toHaveLength(3);
    expect(
      projection.problems.filter(
        (problem) => problem.code === 'bad-date',
      ),
    ).toHaveLength(2);

    const dispatcher = createActionDispatcher({
      state: loaded.state,
      problems: loaded.problems,
      revisions: loaded.revisions,
      mode: 'fixture',
    });

    const inspection = createInspectionProjection(
      dispatcher.snapshot(),
      BUILD,
    );

    expect(inspection.sourceHealth.problemCodes)
      .toEqual(expect.arrayContaining(['bad-number', 'bad-date']));
    expect(inspection.degraded).toEqual({
      state: 'healthy',
      blockingProblemCount: 0,
    });

    expect(
      inspection.board.tasks.find(
        (task) => task.id === 'task-a',
      ),
    ).toMatchObject({
      deadline: null,
      durationMinutes: null,
    });

    expect(
      inspection.calendar.events.find(
        (event) => event.id === 'event-a',
      ),
    ).toMatchObject({
      startDate: '',
      deadline: '',
    });

    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain('NaN');
    expect(serialized).not.toContain('Infinity');
  });

  it('accepts a refreshed generation containing invalid date/number warnings while retaining the structured diagnostics', async () => {
    const vault = validVault();
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial,
    });

    vault.set(TASK_PATH, INVALID_TASK);
    vault.set(EVENT_PATH, INVALID_EVENT);

    const refreshed = await controller.refreshSource(
      'external-signal',
    );

    expect(refreshed).toMatchObject({
      ok: true,
      outcome: 'changed',
      changed: true,
      snapshot: {
        sourceRevision: 2,
        lastSuccessfulRefreshRevision: 2,
        stale: false,
        refreshState: 'idle',
        lastRefreshProblemCode: null,
      },
    });

    expect(
      refreshed.snapshot.load.state.tasks.find(
        (task) => task.id === 'task-a',
      ),
    ).toMatchObject({
      weight: 1,
      orderIndex: 0,
      fixedDuration: null,
      deadline: null,
    });

    expect(
      refreshed.snapshot.load.state.events.find(
        (event) => event.id === 'event-a',
      ),
    ).toMatchObject({
      startDate: '',
      deadline: '',
    });

    const projection = createReadOnlyProjection(
      refreshed.snapshot,
    );
    expect(projection.health.problemCodes)
      .toEqual(expect.arrayContaining(['bad-number', 'bad-date']));

    expect((await vault.read(TASK_PATH)).text)
      .toBe(INVALID_TASK);
    expect((await vault.read(EVENT_PATH)).text)
      .toBe(INVALID_EVENT);
  });

  it('observes external repair through the existing refresh path without rewriting source bytes', async () => {
    const vault = invalidVault();
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({
      vault,
      initial,
    });

    vault.set(TASK_PATH, VALID_TASK);
    vault.set(EVENT_PATH, VALID_EVENT);

    const repaired = await controller.refreshSource('manual');

    expect(repaired).toMatchObject({
      ok: true,
      outcome: 'changed',
      changed: true,
      snapshot: {
        sourceRevision: 2,
        lastSuccessfulRefreshRevision: 2,
        stale: false,
        refreshState: 'idle',
        lastRefreshProblemCode: null,
      },
    });

    expect(
      repaired.snapshot.load.problems.some(
        (problem) =>
          problem.code === 'bad-number'
          || problem.code === 'bad-date',
      ),
    ).toBe(false);

    expect(
      repaired.snapshot.load.state.tasks.find(
        (task) => task.id === 'task-a',
      ),
    ).toMatchObject({
      weight: 2,
      orderIndex: 1,
      fixedDuration: 30,
      deadline: '2026-09-07T12:00:00.000Z',
    });

    expect(
      repaired.snapshot.load.state.events.find(
        (event) => event.id === 'event-a',
      ),
    ).toMatchObject({
      startDate: '2026-09-07T09:00:00.000Z',
      deadline: '2026-09-07T10:00:00.000Z',
    });

    expect((await vault.read(TASK_PATH)).text)
      .toBe(VALID_TASK);
    expect((await vault.read(EVENT_PATH)).text)
      .toBe(VALID_EVENT);
  });
});
