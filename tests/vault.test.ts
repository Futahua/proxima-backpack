import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { parseDocument, parseFrontmatter } from '../src/domain/frontmatter.js';
import { elasticBoard, eventsByDay, reconcileSelection } from '../src/domain/selectors.js';
import { localDateKey } from '../src/domain/time.js';
import { DEFAULT_STATUSES } from '../src/domain/elastic.js';

/** Loads the real fixture files from disk — these are actual bytes, not a mock. */
function loadFixtureFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

const fixtureRoot = fileURLToPath(new URL('../fixtures/vault-basic', import.meta.url));
const vault = createMemoryVault(loadFixtureFiles(fixtureRoot));

describe('frontmatter', () => {
  it('reads scalars, quoted strings, inline and block lists', () => {
    const fm = parseFrontmatter(
      ['name: Studio', 'weight: 3', 'done: true', 'colour: "#00b894"', 'tags: [a, b]'].join('\n'),
    );
    expect(fm).toEqual({ name: 'Studio', weight: 3, done: true, colour: '#00b894', tags: ['a', 'b'] });
  });

  it('keeps a date as a string rather than coercing it to a number', () => {
    expect(parseFrontmatter('deadline: 2026-09-08T18:00:00.000Z').deadline).toBe(
      '2026-09-08T18:00:00.000Z',
    );
  });

  it('separates body from frontmatter and tolerates a file with neither', () => {
    expect(parseDocument('---\nname: X\n---\nbody text').body).toBe('body text');
    expect(parseDocument('just a note').frontmatter).toEqual({});
  });
});

describe('loadVaultState over the real fixture vault', () => {
  it('loads every project, task and event with no problems', async () => {
    const { state, problems } = await loadVaultState(vault);
    expect(problems).toEqual([]);
    expect(state.projects).toHaveLength(3);
    expect(state.tasks).toHaveLength(7);
    expect(state.events).toHaveLength(3);
  });

  it('falls back to the file path for a record with no id', async () => {
    const { state } = await loadVaultState(vault);
    const loose = state.tasks.find((t) => t.name === 'Untitled loose task');
    expect(loose?.id).toBe('Proxima/tasks/Untitled loose task');
  });

  it('reads the elastic fields the board depends on', async () => {
    const { state } = await loadVaultState(vault);
    const standup = state.tasks.find((t) => t.id === 'task-standup');
    expect(standup?.isFixedDuration).toBe(true);
    expect(standup?.fixedDuration).toBe(15);
    expect(state.tasks.find((t) => t.id === 'task-inking')?.maxDuration).toBe(90);
  });

  it('sorts loaded tasks into the three board columns', async () => {
    const { state } = await loadVaultState(vault);
    const board = elasticBoard(state.tasks, DEFAULT_STATUSES);
    expect(board.backlog.map((t) => t.id)).toEqual(['task-colour']);
    expect(board.finished.map((t) => t.id)).toEqual(['task-layout']);
    expect(board.running).toHaveLength(5);
  });

  it('records a revision per file so an external edit is detectable', async () => {
    const first = await loadVaultState(vault);
    vault.set('Proxima/tasks/Daily standup.md', '---\nid: task-standup\nname: Changed\n---\n');
    const second = await loadVaultState(vault);
    expect(second.revisions['Proxima/tasks/Daily standup.md']).not.toBe(
      first.revisions['Proxima/tasks/Daily standup.md'],
    );
  });
});

describe('calendar and selection', () => {
  it('places a multi-day event on every local day it covers', () => {
    const byDay = eventsByDay([
      {
        id: 'e',
        name: 'Studio week',
        description: '',
        projectId: null,
        createdAt: '',
        startDate: '2026-09-14T09:00:00.000Z',
        deadline: '2026-09-18T17:00:00.000Z',
        isCompleted: false,
        properties: {},
      },
    ]);
    // Day coverage is local-calendar, so the count depends on the viewer's zone.
    // Assert the boundaries rather than a number that only holds in one timezone.
    const first = localDateKey('2026-09-14T09:00:00.000Z');
    const last = localDateKey('2026-09-18T17:00:00.000Z');
    const keys = [...byDay.keys()].sort();
    expect(keys[0]).toBe(first);
    expect(keys[keys.length - 1]).toBe(last);
    expect(byDay.get(first)).toHaveLength(1);
    expect(byDay.get(last)).toHaveLength(1);
  });

  it('drops a schedule project when the board asks for it', async () => {
    const { state } = await loadVaultState(vault);
    expect(reconcileSelection(state.projects, 'proj-term', 'board')).toBe('all');
    expect(reconcileSelection(state.projects, 'proj-term', 'calendar')).toBe('proj-term');
    expect(reconcileSelection(state.projects, 'proj-studio', 'board')).toBe('proj-studio');
  });
});
