import { describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  ALL_PROJECTS,
  UNCATEGORISED,
} from '../src/domain/selectors.js';
import { scheduleEventsForSelection } from '../src/browser/scheduleSelection.js';
import { fixtureVault } from './fixtures.js';

describe('Schedule project and event filtering', () => {
  it('shows only Schedule-project or uncategorised events, then applies the existing project selection without mutating source state', async () => {
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
    ).toBe(false);
    expect(
      all.some(
        (event) => event.id === uncategorisedEvent.id,
      ),
    ).toBe(true);
    expect(
      all.every(
        (event) => (
          event.projectId === null
          || event.projectId === scheduleProject.id
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

    expect(
      scheduleEventsForSelection(
        state,
        taskProject.id,
      ),
    ).toEqual([]);

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
