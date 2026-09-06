/**
 * Reads a Proxima state out of ordinary Markdown files in the vault.
 *
 * The vault stays the canonical store and stays human-readable: every project,
 * task and event is one Markdown file with frontmatter, editable in Obsidian
 * exactly as before. Proxima owns the interpretation; it does not own the files.
 *
 * Layout (under the configured root, default "Proxima"):
 *   <root>/projects/*.md
 *   <root>/tasks/*.md
 *   <root>/events/*.md
 */
import {
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  parseDocument,
} from '../domain/frontmatter.js';
import { DEFAULT_STATUSES } from '../domain/elastic.js';
import type { VaultReader } from '../ports/vault.js';
import type {
  CalendarEvent,
  LinkedFolder,
  Project,
  ProximaState,
  Task,
} from '../domain/types.js';

export interface LoadOptions {
  root?: string;
}

export interface LoadResult {
  state: ProximaState;
  /** Files that could not be interpreted. Surfaced, never silently dropped. */
  problems: LoadProblem[];
  /** Path -> revision at load time, so external edits are detectable later. */
  revisions: Record<string, string>;
}

export interface LoadProblem {
  path: string;
  code: 'unreadable' | 'missing-id' | 'missing-name' | 'bad-date';
  detail: string;
}

export async function loadVaultState(
  vault: VaultReader,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const root = (options.root ?? 'Proxima').replace(/^\/+|\/+$/g, '');
  const problems: LoadProblem[] = [];
  const revisions: Record<string, string> = {};

  const projects = await readAll(vault, `${root}/projects`, problems, revisions, toProject);
  const tasks = await readAll(vault, `${root}/tasks`, problems, revisions, toTask);
  const events = await readAll(vault, `${root}/events`, problems, revisions, toEvent);

  return {
    state: { projects, tasks, events, statuses: DEFAULT_STATUSES, taskSchema: [] },
    problems,
    revisions,
  };
}

async function readAll<T>(
  vault: VaultReader,
  directory: string,
  problems: LoadProblem[],
  revisions: Record<string, string>,
  map: (fm: Record<string, unknown>, body: string, path: string, problems: LoadProblem[]) => T | null,
): Promise<T[]> {
  const out: T[] = [];
  let paths: string[];
  try {
    paths = await vault.walk(directory);
  } catch {
    return out;
  }

  for (const path of paths) {
    if (!path.toLowerCase().endsWith('.md')) continue;
    try {
      const file = await vault.read(path);
      revisions[path] = file.revision;
      const parsed = parseDocument(file.text);
      const value = map(parsed.frontmatter, parsed.body.trim(), path, problems);
      if (value) out.push(value);
    } catch (error) {
      problems.push({
        path,
        code: 'unreadable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/** A file with no explicit id is identified by its path — stable, and no writes needed. */
function identify(
  fm: Record<string, unknown>,
  path: string,
): string {
  const explicit = asString(fm.id, '');
  return explicit || path.replace(/\.md$/i, '');
}

function displayName(fm: Record<string, unknown>, path: string): string {
  const explicit = asString(fm.name, '');
  if (explicit) return explicit;
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function toProject(fm: Record<string, unknown>, body: string, path: string): Project {
  const rawType = asString(fm.projectType, 'task');
  return {
    id: identify(fm, path),
    name: displayName(fm, path),
    description: asString(fm.description, body),
    createdAt: asString(fm.createdAt, new Date(0).toISOString()),
    status: asString(fm.status, 'active') === 'archived' ? 'archived' : 'active',
    projectType: rawType === 'schedule' ? 'schedule' : 'task',
    tabBgColor: asString(fm.tabBgColor, '') || undefined,
    tabTextColor: asString(fm.tabTextColor, '') || undefined,
    linkedFolders: toLinkedFolders(fm),
  };
}

function toLinkedFolders(fm: Record<string, unknown>): LinkedFolder[] {
  const single = asString(fm.linkedFolder, '');
  const many = Array.isArray(fm.linkedFolders) ? fm.linkedFolders : [];
  const out: LinkedFolder[] = [];
  if (single) out.push({ name: single.split('/').pop() || single, path: single });
  for (const entry of many) {
    if (typeof entry === 'string' && entry) {
      out.push({ name: entry.split('/').pop() || entry, path: entry });
    }
  }
  return out;
}

function toTask(
  fm: Record<string, unknown>,
  body: string,
  path: string,
  problems: LoadProblem[],
): Task {
  const deadline = asStringOrNull(fm.deadline);
  if (deadline && Number.isNaN(new Date(deadline).getTime())) {
    problems.push({ path, code: 'bad-date', detail: `deadline: ${deadline}` });
  }
  return {
    id: identify(fm, path),
    name: displayName(fm, path),
    description: asString(fm.description, body),
    projectId: asStringOrNull(fm.project),
    status: asString(fm.status, 'running'),
    weight: asNumber(fm.weight, 1),
    orderIndex: asNumber(fm.orderIndex, 0),
    isFixedDuration: asBoolean(fm.isFixedDuration, false),
    fixedDuration: fm.fixedDuration === undefined ? null : asNumber(fm.fixedDuration, 0) || null,
    maxDuration: fm.maxDuration === undefined ? null : asNumber(fm.maxDuration, 0) || null,
    isCompleted: asBoolean(fm.isCompleted, false),
    createdAt: asString(fm.createdAt, new Date(0).toISOString()),
    startDate: asStringOrNull(fm.startDate),
    deadline,
    properties: {},
  };
}

function toEvent(fm: Record<string, unknown>, body: string, path: string): CalendarEvent {
  const start = asString(fm.startDate, '');
  return {
    id: identify(fm, path),
    name: displayName(fm, path),
    description: asString(fm.description, body),
    projectId: asStringOrNull(fm.project),
    createdAt: asString(fm.createdAt, new Date(0).toISOString()),
    startDate: start,
    deadline: asString(fm.deadline, start),
    isCompleted: asBoolean(fm.isCompleted, false),
    properties: {},
  };
}
