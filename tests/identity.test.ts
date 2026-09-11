/**
 * Gate 1A — legacy discovery, and the separation of logical identity from source path.
 *
 * These tests exist because the two defects they pin are silent ones. A reader that
 * treats the path as the identity looks correct until a file moves; a reader that
 * accepts a duplicate id looks correct until something writes to the wrong file.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import {
  declaredTypeVetoesProject,
  discoverFlatRecords,
  discoverProjects,
} from '../src/app/discovery.js';
import {
  LEGACY_LAYOUT,
  LEGACY_ROOT,
  PREFERRED_LAYOUT,
  resolveLayout,
} from '../src/app/vaultLayout.js';
import { projectsFor, reconcileSelection, tasksForSelection } from '../src/domain/selectors.js';
import { problemsFor } from '../src/domain/problems.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

const legacy = () => fixtureVault('vault-legacy');
const duplicates = () => fixtureVault('vault-duplicates');
const loadLegacy = () => loadVaultState(legacy(), { root: LEGACY_ROOT });

describe('vault layout', () => {
  it('defaults to the preferred Proxima-native layout', () => {
    expect(resolveLayout()).toEqual({
      projects: 'Proxima/projects',
      tasks: 'Proxima/tasks',
      events: 'Proxima/events',
    });
    expect(PREFERRED_LAYOUT.projects).toBe('Proxima/projects');
  });

  it('names each legacy default directory explicitly', () => {
    expect(LEGACY_LAYOUT).toEqual({
      projects: '-Hide/Proxima/projects',
      tasks: '-Hide/Proxima/tasks',
      events: '-Hide/Proxima/events',
    });
  });

  it('lets one directory be overridden without moving the others', () => {
    const layout = resolveLayout({ root: LEGACY_ROOT, layout: { tasks: 'Proxima/tasks' } });
    expect(layout.tasks).toBe('Proxima/tasks');
    expect(layout.projects).toBe('-Hide/Proxima/projects');
    expect(layout.events).toBe('-Hide/Proxima/events');
  });

  it('reads a half-moved vault through per-directory overrides', async () => {
    const files = fixtureFiles('vault-legacy');
    const moved: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
      moved[path.replace('-Hide/Proxima/tasks/', 'Proxima/tasks/')] = text;
    }
    const { state } = await loadVaultState(createMemoryVault(moved), {
      root: LEGACY_ROOT,
      layout: { tasks: 'Proxima/tasks' },
    });
    expect(state.projects).toHaveLength(3);
    expect(state.tasks).toHaveLength(4);
  });
});

describe('project discovery', () => {
  const paths = [
    'p/Flat.md',
    'p/Folder/index.md',
    'p/Folder/Notes.md',
    'p/Folder/deep/index.md',
    'p/Folder/deep/more/index.md',
    'p/not-markdown.txt',
  ];

  it('reads a flat project and a folder index, and nothing else', () => {
    const { candidates } = discoverProjects(paths, 'p');
    expect(candidates.map((c) => c.path)).toEqual(['p/Flat.md', 'p/Folder/index.md']);
  });

  it('derives the id from the filename for a flat project', () => {
    const flat = discoverProjects(paths, 'p').candidates.find((c) => c.path === 'p/Flat.md');
    expect(flat).toMatchObject({ derivedId: 'Flat', derivedFrom: 'filename' });
  });

  it('derives the id from the folder for a subfolder project', () => {
    const nested = discoverProjects(paths, 'p').candidates.find((c) => c.path.endsWith('Folder/index.md'));
    expect(nested).toMatchObject({ derivedId: 'Folder', derivedFrom: 'folder' });
  });

  it('does not report a project folder’s own content as a problem', () => {
    expect(discoverProjects(paths, 'p').problems).toEqual([]);
  });
});

describe('the legacy type: marker', () => {
  it('vetoes a project candidate that says it is something else', () => {
    expect(declaredTypeVetoesProject('note')).toBe(true);
    expect(declaredTypeVetoesProject('task')).toBe(true);
  });

  it('accepts a project candidate that says nothing, or says project', () => {
    expect(declaredTypeVetoesProject('')).toBe(false);
    expect(declaredTypeVetoesProject('   ')).toBe(false);
    expect(declaredTypeVetoesProject('project')).toBe(false);
    expect(declaredTypeVetoesProject('Project')).toBe(false);
  });
});

describe('task and event discovery', () => {
  it('reads direct children only, and reports what it skipped', () => {
    const { candidates, problems } = discoverFlatRecords(
      ['t/one.md', 't/sub/two.md', 't/notes.txt'],
      't',
      'task',
    );
    expect(candidates.map((c) => c.derivedId)).toEqual(['one']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: 'ignored-file', path: 't/sub/two.md', kind: 'task' });
  });
});

describe('the legacy creator vault', () => {
  it('loads projects from both the flat and subfolder forms', async () => {
    const { state } = await loadLegacy();
    expect(state.projects.map((p) => p.id).sort()).toEqual([
      'proj-backpack',
      'proj-studio',
      'proj-term',
    ]);
  });

  it('does not turn a project folder’s notes into extra projects', async () => {
    const { state } = await loadLegacy();
    expect(state.projects.filter((p) => p.id.includes('Reference'))).toHaveLength(0);
    expect(state.projects).toHaveLength(3);
  });

  // Regression: the type: marker only ever discriminated projects. The plugin's task
  // and event loaders never read it, so treating it as a universal discriminator
  // silently drops legacy records that carry an unrelated type.
  it('loads a legacy task carrying an unrelated type: field', async () => {
    const { state, problems } = await loadLegacy();
    const task = state.tasks.find((t) => t.id === 'task-1757001');
    expect(task?.name).toBe('Extract domain layer');
    expect(task?.projectId).toBe('proj-backpack');
    expect(problems.filter((p) => p.path.endsWith('task-1757001.md'))).toEqual([]);
  });

  it('loads a legacy event carrying an unrelated type: field', async () => {
    const { state, problems } = await loadLegacy();
    const event = state.events.find((e) => e.id === 'evt-1757100');
    expect(event?.name).toBe('Reviewer gate');
    expect(event?.projectId).toBe('proj-term');
    expect(problems.filter((p) => p.path.endsWith('evt-1757100.md'))).toEqual([]);
  });

  it('never vetoes a task or event on type:, whatever it says', async () => {
    const vault = createMemoryVault({
      'Proxima/tasks/task-a.md': '---\ntype: project\nname: Oddly typed task\n---\n',
      'Proxima/events/evt-a.md': '---\ntype: task\nname: Oddly typed event\n---\n',
    });
    const { state, problems } = await loadVaultState(vault);
    expect(state.tasks.map((t) => t.id)).toEqual(['task-a']);
    expect(state.events.map((e) => e.id)).toEqual(['evt-a']);
    expect(problemsFor(problems, 'unexpected-type')).toEqual([]);
  });

  it('leaves a file alone when its frontmatter says it is not a project', async () => {
    const { state, problems } = await loadLegacy();
    expect(state.projects.some((p) => p.name === 'Folder overview')).toBe(false);
    expect(problemsFor(problems, 'unexpected-type')).toHaveLength(1);
    expect(problemsFor(problems, 'unexpected-type')[0]).toMatchObject({
      path: '-Hide/Proxima/projects/Folder overview.md',
      severity: 'warning',
    });
  });

  it('derives task and event ids from their filenames', async () => {
    const { state } = await loadLegacy();
    expect(state.tasks.map((t) => t.id).sort()).toEqual([
      'task-1757001',
      'task-1757002',
      'task-1757003',
      'task-1757004',
    ]);
    expect(state.events.map((e) => e.id).sort()).toEqual(['evt-1757100', 'evt-1757101']);
  });

  it('keeps an explicit id when the file has been renamed by hand', async () => {
    const { state } = await loadLegacy();
    const renamed = state.tasks.find((t) => t.id === 'task-1757004');
    expect(renamed?.source.path).toBe('-Hide/Proxima/tasks/Renamed by hand.md');
    expect(renamed?.source.idOrigin).toBe('frontmatter');
  });

  it('resolves existing tasks to the right projects, including a folder project', async () => {
    const { state, problems } = await loadLegacy();
    expect(tasksForSelection(state.tasks, 'proj-backpack').map((t) => t.id).sort()).toEqual([
      'task-1757001',
      'task-1757003',
      'task-1757004',
    ]);
    expect(tasksForSelection(state.tasks, 'proj-studio').map((t) => t.id)).toEqual(['task-1757002']);
    expect(problemsFor(problems, 'missing-project')).toEqual([]);
  });

  it('keeps legacy projectType as metadata without using it as a surface silo', async () => {
    const { state } = await loadLegacy();
    const activeIds = [
      'proj-backpack',
      'proj-studio',
      'proj-term',
    ];

    expect(projectsFor(state.projects, 'schedule').map((p) => p.id).sort()).toEqual(activeIds);
    expect(projectsFor(state.projects, 'task').map((p) => p.id).sort()).toEqual(activeIds);
    expect(state.projects.find((project) => project.id === 'proj-term')?.projectType).toBe(
      'schedule',
    );
    expect(reconcileSelection(state.projects, 'proj-term', 'board')).toBe('proj-term');
    expect(reconcileSelection(state.projects, 'proj-term', 'calendar')).toBe('proj-term');
  });

  it('reads a single linkedFolder', async () => {
    const { state } = await loadLegacy();
    const project = state.projects.find((p) => p.id === 'proj-backpack');
    expect(project?.linkedFolders).toEqual([{ name: 'Drawings', path: 'Drawings' }]);
  });

  it('reads the packed legacy "Name|path;Name|path" linkedFolders string', async () => {
    const { state } = await loadLegacy();
    const project = state.projects.find((p) => p.id === 'proj-studio');
    expect(project?.linkedFolders).toEqual([
      { name: 'Art', path: 'Drawings/Art' },
      { name: 'References', path: 'Refs/Studio' },
    ]);
  });

  it('reads legacy elastic fields unchanged', async () => {
    const { state } = await loadLegacy();
    expect(state.tasks.find((t) => t.id === 'task-1757003')).toMatchObject({
      isFixedDuration: true,
      fixedDuration: 15,
    });
    expect(state.tasks.find((t) => t.id === 'task-1757002')?.maxDuration).toBe(90);
  });

  it('needs no migration and no write to be readable', async () => {
    const vault = legacy();
    const before = fixtureFiles('vault-legacy');
    await loadVaultState(vault, { root: LEGACY_ROOT });
    for (const [path, text] of Object.entries(before)) {
      expect((await vault.read(path)).text).toBe(text);
    }
  });
});

describe('source provenance', () => {
  it('gives every record a path, a revision and its kind', async () => {
    const { state } = await loadLegacy();
    for (const record of [...state.projects, ...state.tasks, ...state.events]) {
      expect(record.source.path).toMatch(/^-Hide\/Proxima\/.+\.md$/);
      expect(record.source.revision).not.toBe('');
      expect(['project', 'task', 'event']).toContain(record.source.kind);
    }
  });

  it('records where each id came from', async () => {
    const { state } = await loadLegacy();
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    expect(byId.get('proj-backpack')?.source.idOrigin).toBe('filename');
    expect(byId.get('proj-studio')?.source.idOrigin).toBe('folder');
    expect(byId.get('proj-studio')?.source.path).toBe('-Hide/Proxima/projects/proj-studio/index.md');
  });

  it('keeps the logical id distinct from the source path', async () => {
    const { state } = await loadLegacy();
    for (const task of state.tasks) {
      expect(task.id).not.toContain('/');
      expect(task.id).not.toBe(task.source.path);
    }
  });

  it('tracks a revision per source file so an external edit is detectable', async () => {
    const vault = legacy();
    const first = await loadVaultState(vault, { root: LEGACY_ROOT });
    vault.set(
      '-Hide/Proxima/tasks/task-1757003.md',
      '---\nname: Changed outside Proxima\nstatus: running\n---\n',
    );
    const second = await loadVaultState(vault, { root: LEGACY_ROOT });
    const path = '-Hide/Proxima/tasks/task-1757003.md';
    expect(second.revisions[path]).not.toBe(first.revisions[path]);
    expect(second.state.tasks.find((t) => t.id === 'task-1757003')?.source.revision).toBe(
      second.revisions[path],
    );
  });
});

describe('duplicate logical ids', () => {
  it('refuses the second project and says which file already holds the id', async () => {
    const { state, problems } = await loadVaultState(duplicates());
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]?.name).toBe('Twin (flat)');

    const collisions = problemsFor(problems, 'duplicate-id').filter((p) => p.kind === 'project');
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      severity: 'error',
      id: 'proj-twin',
      path: 'Proxima/projects/proj-twin/index.md',
    });
    expect(collisions[0]?.detail).toContain('Proxima/projects/proj-twin.md');
  });

  it('refuses a derived id that collides with a declared one', async () => {
    const { state, problems } = await loadVaultState(duplicates());
    expect(state.tasks.map((t) => t.id)).toEqual(['task-shared']);
    expect(state.tasks[0]?.name).toBe('Declared the id');
    expect(problemsFor(problems, 'duplicate-id').filter((p) => p.kind === 'task')).toHaveLength(1);
  });

  it('resolves the collision the same way every run', async () => {
    const runs = await Promise.all([
      loadVaultState(duplicates()),
      loadVaultState(duplicates()),
      loadVaultState(duplicates()),
    ]);
    const winners = runs.map((r) => r.state.projects[0]?.source.path);
    expect(new Set(winners).size).toBe(1);
  });

  it('reports a task filed below the tasks directory instead of dropping it', async () => {
    const { problems } = await loadVaultState(duplicates());
    expect(problemsFor(problems, 'ignored-file')).toHaveLength(1);
    expect(problemsFor(problems, 'ignored-file')[0]?.path).toBe(
      'Proxima/tasks/archive/task-old.md',
    );
  });

  it('reports a reference to a project that did not load', async () => {
    const { state, problems } = await loadVaultState(duplicates());
    expect(state.events.map((e) => e.id)).toEqual(['evt-orphan']);
    expect(problemsFor(problems, 'missing-project')[0]).toMatchObject({
      kind: 'event',
      id: 'evt-orphan',
      severity: 'warning',
    });
  });
});
