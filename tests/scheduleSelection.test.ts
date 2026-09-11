import { describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  ALL_PROJECTS,
  UNCATEGORISED,
} from '../src/domain/selectors.js';
import { scheduleEventsForSelection } from '../src/browser/scheduleSelection.js';
import { fixtureVault } from './fixtures.js';

describe('Schedule project and event filtering', () => {
  it('shows events from any active project before applying selection without mutating source state', async () => {
    const loaded = await loadVaultState(
      fixtureVault('vault-basic'),
    );
    const scheduleProject = loaded.state.projects.find(
      (project) => project.projectType === 'schedule',
    );
    const taskProject = loaded.state.projects.find(
      (project) => project.projectType === 'task',
    );
    const template = loaded.state.events[0];

    expect(scheduleProject).toBeDefined();
    expect(taskProject).toBeDefined();
    expect(template).toBeDefined();

    if (!scheduleProject || !taskProject || !template) {
      throw new Error('vault-basic must contain schedule/task projects and an event');
    }

    const taskProjectEvent = {
      ...template,
      id: 'schedule-filter-task-project',
      projectId: taskProject.id,
    };
    const uncategorisedEvent = {
      ...template,
      id: 'schedule-filter-uncategorised',
      projectId: null,
    };
    const state = {
      ...loaded.state,
      events: [
        ...loaded.state.events,
        taskProjectEvent,
        uncategorisedEvent,
      ],
    };
    const before = JSON.stringify(state);

    const all = scheduleEventsForSelection(
      state,
      ALL_PROJECTS,
    );
    expect(
      all.some(
        (event) => event.id === taskProjectEvent.id,
      ),
    ).toBe(true);
    expect(
      all.some(
        (event) => event.id === uncategorisedEvent.id,
      ),
    ).toBe(true);
    const activeProjectIds = new Set(
      state.projects
        .filter((project) => project.status === 'active')
        .map((project) => project.id),
    );
    expect(
      all.every(
        (event) => (
          event.projectId === null
          || activeProjectIds.has(event.projectId)
        ),
      ),
    ).toBe(true);

    const selectedSchedule = scheduleEventsForSelection(
      state,
      scheduleProject.id,
    );
    expect(
      selectedSchedule.every(
        (event) => event.projectId === scheduleProject.id,
      ),
    ).toBe(true);

    const selectedTask = scheduleEventsForSelection(
      state,
      taskProject.id,
    );
    expect(
      selectedTask.every(
        (event) => event.projectId === taskProject.id,
      ),
    ).toBe(true);
    expect(
      selectedTask.some(
        (event) => event.id === taskProjectEvent.id,
      ),
    ).toBe(true);

    const uncategorised = scheduleEventsForSelection(
      state,
      UNCATEGORISED,
    );
    expect(
      uncategorised.every(
        (event) => event.projectId === null,
      ),
    ).toBe(true);
    expect(
      uncategorised.some(
        (event) => event.id === uncategorisedEvent.id,
      ),
    ).toBe(true);

    expect(JSON.stringify(state)).toBe(before);
  });
});
