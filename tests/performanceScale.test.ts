import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { calculateElasticTimeline, elasticCardHeights } from '../src/domain/elastic.js';
import type { Task } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';
import { eventsByDay } from '../src/domain/selectors.js';
import type { CalendarEvent } from '../src/domain/types.js';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { createInspectionProjection } from '../src/app/inspection.js';
import { createCanvasNode } from '../src/domain/canvas.js';
import { selectCanvasRepresentation } from '../src/domain/canvasRenderer.js';
import { renderCanvasSurface, type CanvasSurfaceState } from '../src/browser/canvasSurface.js';
import { sequentialIdGenerator } from '../src/domain/clock.js';

function scaledVault(count: number) {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    const id = `project-${String(i).padStart(4, '0')}`;
    files[`Proxima/projects/${id}.md`] = `---\nid: ${id}\nname: Project ${i}\nprojectType: task\nstatus: active\n---\nProject body ${i}.\n`;
    files[`Proxima/tasks/task-${String(i).padStart(4, '0')}.md`] = `---\nid: task-${String(i).padStart(4, '0')}\nname: Task ${i}\nproject: ${id}\nstatus: running\nweight: 1\n---\nTask body ${i}.\n`;
    files[`Proxima/events/event-${String(i).padStart(4, '0')}.md`] = `---\nid: event-${String(i).padStart(4, '0')}\nname: Event ${i}\nproject: ${id}\nstartDate: 2026-09-${String((i % 28) + 1).padStart(2, '0')}\ndeadline: 2026-09-${String((i % 28) + 1).padStart(2, '0')}\n---\nEvent body ${i}.\n`;
  }
  return createMemoryVault(files);
}

function runningTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `running-${i}`,
    source: sourceRef('task', `running-${i}`),
    name: `Running ${i}`,
    description: '',
    projectId: null,
    status: 'running',
    weight: (i % 5) + 1,
    orderIndex: i,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    startDate: null,
    deadline: null,
    properties: {},
  }));
}

function monthlyEvents(count: number): CalendarEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String((i % 27) + 1).padStart(2, '0');
    const nextDay = String((i % 27) + 2).padStart(2, '0');
    const startDate = `2026-09-${day}`;
    return {
      id: `monthly-${i}`,
      source: sourceRef('event', `monthly-${i}`),
      name: `Monthly ${i}`,
      description: '',
      projectId: null,
      createdAt: startDate,
      startDate,
      deadline: i % 5 === 0 ? `2026-09-${nextDay}` : startDate,
      isCompleted: false,
      properties: {},
    };
  });
}

describe('Gate 18A deterministic load/refresh scale baseline', () => {
  it.each([100, 1000])('loads %i projects, tasks and events with complete census', async (count) => {
    const vault = scaledVault(count);
    const started = performance.now();
    const loaded = await loadVaultState(vault);
    const elapsedMs = performance.now() - started;

    expect(loaded.state.projects).toHaveLength(count);
    expect(loaded.state.tasks).toHaveLength(count);
    expect(loaded.state.events).toHaveLength(count);
    expect(loaded.census.project.unaccountedCandidates).toBe(0);
    expect(loaded.census.task.unaccountedCandidates).toBe(0);
    expect(loaded.census.event.unaccountedCandidates).toBe(0);
    // This is a broad regression guard, not a product SLA; the measurement itself
    // remains visible in a failing run without making small CI timing noise flaky.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('refreshes a 1000-record source unchanged and after one edit', async () => {
    const vault = scaledVault(1000);
    const initial = await loadVaultState(vault);
    const controller = createRefreshController({ vault, initial });

    const unchangedStart = performance.now();
    const unchanged = await controller.refreshSource('manual');
    const unchangedMs = performance.now() - unchangedStart;
    expect(unchanged.outcome).toBe('unchanged');
    expect(unchanged.changed).toBe(false);
    expect(unchanged.snapshot.sourceRevision).toBe(1);

    vault.set('Proxima/tasks/task-0000.md', '---\nid: task-0000\nname: Edited at scale\nproject: project-0000\nstatus: running\nweight: 1\n---\n\n');
    const changedStart = performance.now();
    const changed = await controller.refreshSource('external-signal');
    const changedMs = performance.now() - changedStart;
    expect(changed.outcome).toBe('changed');
    expect(changed.changed).toBe(true);
    expect(changed.snapshot.sourceRevision).toBe(2);
    expect(changed.snapshot.load.state.tasks.find((task) => task.id === 'task-0000')?.name).toBe('Edited at scale');
    expect(unchangedMs).toBeLessThan(5000);
    expect(changedMs).toBeLessThan(5000);
  });

  it('keeps the 1000-running-task Elastic hot path bounded and linear', () => {
    const running = runningTasks(1000);
    const started = performance.now();
    const timeline = calculateElasticTimeline(running, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-02T00:00:00.000Z'));
    const heights = elasticCardHeights(running, timeline, 100_000, 1);
    const elapsedMs = performance.now() - started;

    expect(timeline).toHaveLength(1000);
    expect(Object.keys(heights)).toHaveLength(1000);
    expect(heights['running-0']).toBeGreaterThan(0);
    expect(heights['running-999']).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('groups 1000 events concentrated in one month with complete deterministic coverage', () => {
    const events = monthlyEvents(1000);
    const problems: never[] = [];
    const started = performance.now();
    const byDay = eventsByDay(events, problems);
    const elapsedMs = performance.now() - started;
    const grouped = [...byDay.values()].flat();

    expect(problems).toEqual([]);
    expect(byDay.size).toBe(28);
    expect(grouped).toHaveLength(1200);
    expect(new Set(grouped.map((event) => event.id))).toEqual(new Set(events.map((event) => event.id)));
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('keeps 1000-event inspection day-key projection linear and bounded', () => {
    const events = monthlyEvents(1000);
    const state = { projects: [], tasks: [], events, statuses: [], taskSchema: [] } as never;
    const dispatcher = createActionDispatcher({ state, mode: 'fixture' });
    const started = performance.now();
    const projection = createInspectionProjection(dispatcher.snapshot(), {
      proximaVersion: '0.1.0', gitSha: 'test', buildMode: 'fixture', domainSchemaVersion: '1',
      controlSchemaVersion: '1', fixtureSchemaVersion: '1', fixtureHash: 'fixture', lockfileHash: 'lock',
      fixedClock: '2026-09-01T00:00:00.000Z',
    });
    const elapsedMs = performance.now() - started;

    expect(projection.calendar.events).toHaveLength(500);
    expect(projection.calendar.events[0]?.dayKeys).toEqual(['2026-09-01', '2026-09-02']);
    expect(projection.loadProblems).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('renders 1000 passive canvas nodes with complete identity accounting', () => {
    const ids = sequentialIdGenerator();
    const items = Array.from({ length: 1000 }, (_, index) => {
      const node = createCanvasNode(ids, { kind: 'browser-file', sourceId: `source-${index}`, filename: `file-${index}.bin`, extension: 'bin', state: 'available', mimeType: 'application/octet-stream', size: 1, modifiedAt: null });
      return { node, selection: selectCanvasRepresentation(node.source, null), status: 'selected' as const, presentationDiagnostic: null };
    });
    const state: CanvasSurfaceState = { items, lastDropDiagnostic: null };
    const started = performance.now();
    const html = renderCanvasSurface(state);
    const elapsedMs = performance.now() - started;

    expect((html.match(/class="canvas-card"/g) ?? []).length).toBe(1000);
    expect((html.match(/data-canvas-node-id=/g) ?? []).length).toBe(1000);
    expect(html).toContain('file-0.bin');
    expect(html).toContain('file-999.bin');
    expect(elapsedMs).toBeLessThan(5000);
  });
});
