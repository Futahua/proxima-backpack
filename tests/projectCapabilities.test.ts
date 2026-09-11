import { describe, expect, it } from 'vitest';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  ALL_PROJECTS,
  projectCapabilities,
  projectsFor,
  reconcileSelection,
} from '../src/domain/selectors.js';
import { fixtureVault } from './fixtures.js';

async function combinedProjectState(projectType: 'task' | 'schedule') {
  const loaded = await loadVaultState(fixtureVault('vault-basic'));
  const projectTemplate = loaded.state.projects.find(
    (project) => project.status === 'active',
  )!;
  const taskTemplate = loaded.state.tasks[0]!;
  const eventTemplate = loaded.state.events[0]!;
  const project = {
    ...projectTemplate,
    id: 'proj-combined-a4',
    name: 'Combined A4 project',
    projectType,
    linkedFolders: [
      {
        name: 'Combined workspace',
        path: 'Projects/Combined A4',
      },
    ],
  };
  const task = {
    ...taskTemplate,
    id: 'task-combined-a4',
    projectId: project.id,
  };
  const event = {
    ...eventTemplate,
    id: 'event-combined-a4',
    projectId: project.id,
  };

  return {
    state: {
      ...loaded.state,
      projects: [...loaded.state.projects, project],
      tasks: [...loaded.state.tasks, task],
      events: [...loaded.state.events, event],
    },
    project,
    task,
    event,
  };
}

describe('HARD GATE A / A4 project capabilities', () => {
  it('lets one project simultaneously own task, schedule and configured workspace capabilities', async () => {
    const { state, project, task, event } = await combinedProjectState('schedule');

    expect(projectCapabilities(state, project.id)).toEqual({
      taskBoard: true,
      schedule: true,
      notes: true,
    });
    expect(task.projectId).toBe(project.id);
    expect(event.projectId).toBe(project.id);

    expect(
      projectsFor(state.projects, 'task').some(
        (candidate) => candidate.id === project.id,
      ),
    ).toBe(true);
    expect(
      projectsFor(state.projects, 'schedule').some(
        (candidate) => candidate.id === project.id,
      ),
    ).toBe(true);
  });

  it('does not let the legacy projectType label change capability or selection semantics', async () => {
    const formerTask = await combinedProjectState('task');
    const formerSchedule = await combinedProjectState('schedule');

    expect(
      projectCapabilities(formerTask.state, formerTask.project.id),
    ).toEqual(
      projectCapabilities(formerSchedule.state, formerSchedule.project.id),
    );

    expect(
      reconcileSelection(
        formerSchedule.state.projects,
        formerSchedule.project.id,
        'board',
      ),
    ).toBe(formerSchedule.project.id);
    expect(
      reconcileSelection(
        formerTask.state.projects,
        formerTask.project.id,
        'calendar',
      ),
    ).toBe(formerTask.project.id);
  });

  it('keeps archived projects unavailable without reviving the former type silo', async () => {
    const { state, project } = await combinedProjectState('schedule');
    const archived = {
      ...project,
      status: 'archived' as const,
    };
    const archivedState = {
      ...state,
      projects: state.projects.map(
        (candidate) => candidate.id === project.id ? archived : candidate,
      ),
    };

    expect(projectCapabilities(archivedState, project.id)).toEqual({
      taskBoard: false,
      schedule: false,
      notes: false,
    });
    expect(
      reconcileSelection(
        archivedState.projects,
        project.id,
        'board',
      ),
    ).toBe(ALL_PROJECTS);
    expect(
      reconcileSelection(
        archivedState.projects,
        project.id,
        'calendar',
      ),
    ).toBe(ALL_PROJECTS);
  });
});
