import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createRefreshController } from '../src/app/refreshController.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

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
});
