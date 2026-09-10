import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspacePath = resolve(
  process.cwd(),
  'src/browser/projectWorkspace.ts',
);

function workspaceSource(): string {
  return readFileSync(workspacePath, 'utf8');
}

describe('Stage 5 slice 10 project workspace ownership closeout', () => {
  it('keeps each detailed workspace surface owned by its dedicated module', () => {
    const source = workspaceSource();

    expect(source).toContain(
      "return renderProjectNotes(options.project,options.notes??EMPTY_PROJECT_NOTES_VIEW)",
    );
    expect(source).toContain(
      "return renderProjectTaskBoard(options.state,options.project,options.taskBoard??EMPTY_PROJECT_TASK_BOARD_VIEW)",
    );
    expect(source).toContain(
      "return renderProjectBacklog(options.state,options.project,options.backlog??EMPTY_PROJECT_BACKLOG_VIEW)",
    );
    expect(source).toContain(
      "return renderProjectDeadlines(options.state,options.project,options.now,options.deadlines??EMPTY_PROJECT_DEADLINES_VIEW)",
    );
    expect(source).toContain(
      "return renderProjectSchedule(options.state,options.project,options.now,options.schedule??EMPTY_PROJECT_SCHEDULE_VIEW)",
    );
  });

  it('contains no superseded inline workspace projection or renderer implementation', () => {
    const source = workspaceSource();

    expect(source).not.toContain('function renderTaskBoard(');
    expect(source).not.toContain('function renderBacklog(');
    expect(source).not.toContain('function renderDeadlines(');
    expect(source).not.toContain('function renderSchedule(');
    expect(source).not.toContain('function projectTasks(');
    expect(source).not.toContain('function projectEvents(');
    expect(source).not.toContain('function taskOrder(');
    expect(source).not.toContain('function eventOrder(');
    expect(source).not.toContain('function statusColumns(');
    expect(source).not.toContain('deadlineCalendarProjection');
    expect(source).not.toContain('CalendarEvent');
    expect(source).not.toContain('StatusDefinition');
  });
});
