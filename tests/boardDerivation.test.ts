import { describe, expect, it } from 'vitest';
import { elasticBoard, projectsFor, reconcileSelection, tasksForSelection, ALL_PROJECTS, UNCATEGORISED } from '../src/domain/selectors.js';
import { columnOf } from '../src/domain/elastic.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureVault } from './fixtures.js';

describe('Gate 6.2A board derivation', () => {
  it('filters all, uncategorised and selected tasks without a legacy project-type silo', async () => {
    const { state } = await loadVaultState(fixtureVault('vault-basic'));
    const formerScheduleProject = state.projects.find(
      (project) => project.projectType === 'schedule' && project.status === 'active',
    )!;
    const template = state.tasks[0]!;
    const crossCapabilityTask = {
      ...template,
      id: 'former-schedule-project-task',
      projectId: formerScheduleProject.id,
    };
    const taskProjects = projectsFor(state.projects, 'task');
    const scheduleProjects = projectsFor(state.projects, 'schedule');
    const eligible = [...state.tasks, crossCapabilityTask].filter(
      (task) => !task.projectId || taskProjects.some((project) => project.id === task.projectId),
    );
    expect(taskProjects.map((project) => project.id)).toEqual(
      scheduleProjects.map((project) => project.id),
    );
    expect(tasksForSelection(eligible, ALL_PROJECTS)).toEqual(eligible);
    expect(tasksForSelection(eligible, UNCATEGORISED).every((task) => !task.projectId)).toBe(true);
    expect(tasksForSelection(eligible, 'proj-backpack').every((task) => task.projectId === 'proj-backpack')).toBe(true);
    expect(eligible.some((task) => task.id === crossCapabilityTask.id)).toBe(true);
    expect(reconcileSelection(state.projects, formerScheduleProject.id, 'board')).toBe(
      formerScheduleProject.id,
    );
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
