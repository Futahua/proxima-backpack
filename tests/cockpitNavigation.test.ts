import { describe, expect, it } from 'vitest';
import { cockpitSubmode, renderCockpitNavigation } from '../src/browser/cockpitNavigation.js';

describe('Stage 1 cockpit navigation', () => {
  it('renders the four top-level destinations with stable machine keys', () => {
    const html = renderCockpitNavigation({
      surface: 'tasks',
      tasksMode: 'elastic',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
    });

    expect(html).toContain('data-c1-key="surface-tab-tasks"');
    expect(html).toContain('data-c1-key="surface-tab-schedule"');
    expect(html).toContain('data-c1-key="surface-tab-projects"');
    expect(html).toContain('data-c1-key="surface-tab-canvas"');
    expect(html).not.toContain('data-c1-key="surface-tab-board"');
    expect(html).not.toContain('data-c1-key="surface-tab-calendar"');
  });

  it('renders both Tasks modes independently of their visible labels', () => {
    const html = renderCockpitNavigation({
      surface: 'tasks',
      tasksMode: 'timekeeping',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
    });

    expect(html).toContain('data-c1-key="tasks-mode-elastic"');
    expect(html).toContain('data-c1-key="tasks-mode-timekeeping"');
    expect(html).toContain('data-tasks-mode="timekeeping"');
    expect(cockpitSubmode({
      surface: 'tasks',
      tasksMode: 'timekeeping',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
    })).toBe('timekeeping');
  });

  it('renders all six Schedule modes', () => {
    const html = renderCockpitNavigation({
      surface: 'schedule',
      tasksMode: 'elastic',
      scheduleMode: 'week',
      projectWorkspaceTab: 'notes',
    });

    for (const key of ['day', 'four-day', 'week', 'month', 'year', 'agenda']) {
      expect(html).toContain(`data-c1-key="schedule-mode-${key}"`);
    }

    expect(cockpitSubmode({
      surface: 'schedule',
      tasksMode: 'elastic',
      scheduleMode: 'week',
      projectWorkspaceTab: 'notes',
    })).toBe('week');
  });

  it('renders the project workspace tabs and leaves Canvas without a submode', () => {
    const projects = renderCockpitNavigation({
      surface: 'projects',
      tasksMode: 'elastic',
      scheduleMode: 'month',
      projectWorkspaceTab: 'deadlines',
    });

    for (const key of ['notes', 'task-board', 'backlog', 'deadlines', 'schedule']) {
      expect(projects).toContain(`data-c1-key="project-tab-${key}"`);
    }

    expect(cockpitSubmode({
      surface: 'canvas',
      tasksMode: 'elastic',
      scheduleMode: 'month',
      projectWorkspaceTab: 'notes',
    })).toBeNull();
  });
});
