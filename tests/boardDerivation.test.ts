import { describe, expect, it } from 'vitest';
import { elasticBoard, projectsFor, reconcileSelection, tasksForSelection, ALL_PROJECTS, UNCATEGORISED } from '../src/domain/selectors.js';
import { columnOf } from '../src/domain/elastic.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

describe('Gate 6.2A board derivation', () => {
  it('filters all, uncategorised and selected tasks and excludes schedule projects', async () => {
    const { state } = await loadVaultState(fixtureVault('vault-basic'));
    const taskProjects = projectsFor(state.projects, 'task');
    const eligible = state.tasks.filter((task) => !task.projectId || taskProjects.some((project) => project.id === task.projectId));
    expect(tasksForSelection(eligible, ALL_PROJECTS)).toEqual(eligible);
    expect(tasksForSelection(eligible, UNCATEGORISED).every((task) => !task.projectId)).toBe(true);
    expect(tasksForSelection(eligible, 'proj-backpack').every((task) => task.projectId === 'proj-backpack')).toBe(true);
    expect(eligible.some((task) => task.projectId === 'proj-term')).toBe(false);
    expect(taskProjects.every((project) => project.status === 'active' && project.projectType === 'task')).toBe(true);
  });

  it('reconciles inactive selections away from both board and calendar', async () => {
    const { state } = await loadVaultState(fixtureVault('vault-basic'));
    const baseTaskProject = state.projects.find((project) => project.projectType === 'task')!;
    const baseScheduleProject = state.projects.find((project) => project.projectType === 'schedule')!;
    const inactiveTask = { ...baseTaskProject, id: 'inactive-task', status: 'archived' as const, projectType: 'task' as const };
    const inactiveSchedule = { ...baseScheduleProject, id: 'inactive-schedule', status: 'archived' as const };
    const projects = [...state.projects, inactiveTask, inactiveSchedule];
    expect(reconcileSelection(projects, inactiveTask.id, 'board')).toBe(ALL_PROJECTS);
    expect(reconcileSelection(projects, inactiveSchedule.id, 'calendar')).toBe(ALL_PROJECTS);
  });

  it('sorts every board column by numeric orderIndex and preserves input order for ties', async () => {
    const { state } = await loadVaultState(fixtureVault('vault-basic'));
    const template = state.tasks.find((task) => columnOf(task, state.statuses) === 'running')!;
    const tasks = [-2, 1.5, 9, 1.5].map((orderIndex, index) => ({ ...template, id: `order-${index}`, orderIndex }));
    const board = elasticBoard(tasks, state.statuses);
    expect(board.running.map((task) => task.id)).toEqual(['order-0', 'order-1', 'order-3', 'order-2']);
  });
});
