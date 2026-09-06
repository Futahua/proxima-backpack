/**
 * Reads a Proxima state out of ordinary Markdown files in the vault.
 *
 * The vault stays the canonical store and stays human-readable: every project, task
 * and event is one Markdown file with frontmatter, editable in Obsidian exactly as
 * before. Proxima owns the interpretation; it does not own the files.
 *
 * Two things this reader refuses to do, both because they would damage real creator
 * data rather than merely inconvenience it:
 *
 *   - migrate or rewrite anything in order to read it. Legacy layouts are read where
 *     they are. Nothing here writes.
 *   - accept two records with the same logical id. The second one is rejected and
 *     reported, because silently letting an id alias means a later write — or a later
 *     agent command — hits a file nobody chose.
 *
 * Layouts and discovery rules live in `vaultLayout.ts` and `discovery.ts`.
 */
import {
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  parseDocument,
} from '../domain/frontmatter.js';
import { DEFAULT_STATUSES } from '../domain/elastic.js';
import type { LoadProblem } from '../domain/problems.js';
import type { IdOrigin, RecordKind, SourceRef } from '../domain/records.js';
import type { VaultReader } from '../ports/vault.js';
import type {
  CalendarEvent,
  LinkedFolder,
  Project,
  ProximaState,
  Task,
} from '../domain/types.js';
import { discoverFlatRecords, discoverProjects, typeMatchesKind } from './discovery.js';
import { directoryFor, resolveLayout, type VaultLayout } from './vaultLayout.js';

export interface LoadOptions {
  /** Root holding projects/, tasks/ and events/. Defaults to "Proxima". */
  root?: string;
  /** Per-directory overrides, for a vault that has been rearranged by hand. */
  layout?: Partial<VaultLayout>;
}

export interface LoadResult {
  state: ProximaState;
  /** Everything the reader could not interpret, or interpreted with a caveat. */
  problems: LoadProblem[];
  /** Source path -> revision at load time, so external edits are detectable later. */
  revisions: Record<string, string>;
  /** The layout actually used, so a caller can report what it read. */
  layout: VaultLayout;
}

/** One file, parsed, before it becomes a domain record. */
interface SourcedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  source: SourceRef;
}

export async function loadVaultState(
  vault: VaultReader,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const layout = resolveLayout(options);
  const problems: LoadProblem[] = [];
  const revisions: Record<string, string> = {};

  const projectDocs = await readKind(vault, layout, 'project', problems, revisions);
  const taskDocs = await readKind(vault, layout, 'task', problems, revisions);
  const eventDocs = await readKind(vault, layout, 'event', problems, revisions);

  const projects = collect(projectDocs, problems, toProject);
  const tasks = collect(taskDocs, problems, toTask);
  const events = collect(eventDocs, problems, toEvent);

  reportMissingProjects(projects, tasks, events, problems);

  return {
    state: { projects, tasks, events, statuses: DEFAULT_STATUSES, taskSchema: [] },
    problems,
    revisions,
    layout,
  };
}

/** Read and parse every file the discovery rules accept for one record kind. */
async function readKind(
  vault: VaultReader,
  layout: VaultLayout,
  kind: RecordKind,
  problems: LoadProblem[],
  revisions: Record<string, string>,
): Promise<SourcedDocument[]> {
  const directory = directoryFor(layout, kind);

  let paths: string[];
  try {
    paths = await vault.walk(directory);
  } catch (error) {
    problems.push({
      code: 'directory-unreadable',
      severity: 'warning',
      path: directory,
      kind,
      detail: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const discovery =
    kind === 'project'
      ? discoverProjects(paths, directory)
      : discoverFlatRecords(paths, directory, kind);
  problems.push(...discovery.problems);

  const documents: SourcedDocument[] = [];
  for (const candidate of discovery.candidates) {
    let text: string;
    let revision: string;
    try {
      const file = await vault.read(candidate.path);
      text = file.text;
      revision = file.revision;
    } catch (error) {
      problems.push({
        code: 'unreadable',
        severity: 'error',
        path: candidate.path,
        kind,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    revisions[candidate.path] = revision;
    const parsed = parseDocument(text);

    const declaredType = asString(parsed.frontmatter.type, '');
    if (!typeMatchesKind(declaredType, kind)) {
      problems.push({
        code: 'unexpected-type',
        severity: 'warning',
        path: candidate.path,
        kind,
        detail: `frontmatter says type: ${declaredType}, so it is not read as a ${kind}.`,
      });
      continue;
    }

    const explicitId = asString(parsed.frontmatter.id, '').trim();
    const idOrigin: IdOrigin = explicitId ? 'frontmatter' : candidate.derivedFrom;

    documents.push({
      frontmatter: parsed.frontmatter,
      body: parsed.body.trim(),
      source: {
        path: candidate.path,
        revision,
        kind,
        idOrigin,
      },
    });
  }

  return documents;
}

/**
 * Turn parsed documents into records, refusing a duplicate logical id.
 *
 * Candidates arrive in a deterministic path order, so "first wins" is a rule rather
 * than a race: the same vault always produces the same winner and the same report.
 */
function collect<T extends { id: string; source: SourceRef }>(
  documents: SourcedDocument[],
  problems: LoadProblem[],
  map: (doc: SourcedDocument, id: string, problems: LoadProblem[]) => T,
): T[] {
  const out: T[] = [];
  const claimed = new Map<string, string>();

  for (const doc of documents) {
    const id = resolveId(doc);
    const existing = claimed.get(id);
    if (existing !== undefined) {
      problems.push({
        code: 'duplicate-id',
        severity: 'error',
        path: doc.source.path,
        kind: doc.source.kind,
        id,
        detail: `id "${id}" is already used by ${existing}; this ${doc.source.kind} was not loaded.`,
      });
      continue;
    }
    claimed.set(id, doc.source.path);
    out.push(map(doc, id, problems));
  }

  return out;
}

/**
 * The logical id: what the file declares, or what its position implies.
 *
 * An explicit `id:` wins unconditionally, which is what makes a rename safe — the
 * record keeps its identity because the identity was never the path. A file with no
 * declared id falls back to its own name, matching the legacy convention, and that
 * fallback does move when the file moves. There is nothing else it could be.
 */
function resolveId(doc: SourcedDocument): string {
  const explicit = asString(doc.frontmatter.id, '').trim();
  if (explicit) return explicit;
  return derivedIdFor(doc.source);
}

function derivedIdFor(source: SourceRef): string {
  const segments = source.path.split('/');
  if (source.idOrigin === 'folder') return segments[segments.length - 2] ?? source.path;
  return (segments[segments.length - 1] ?? source.path).replace(/\.md$/i, '');
}

function displayName(fm: Record<string, unknown>, id: string): string {
  return asString(fm.name, '') || id;
}

/** Legacy files wrote `projectId`; the preferred format writes `project`. Both read. */
function projectReference(fm: Record<string, unknown>): string | null {
  return asStringOrNull(fm.project) ?? asStringOrNull(fm.projectId);
}

function toProject(doc: SourcedDocument, id: string): Project {
  const { frontmatter: fm, body, source } = doc;
  return {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    createdAt: asString(fm.createdAt, EPOCH),
    status: asString(fm.status, 'active') === 'archived' ? 'archived' : 'active',
    projectType: asString(fm.projectType, 'task') === 'schedule' ? 'schedule' : 'task',
    tabBgColor: asString(fm.tabBgColor, '') || undefined,
    tabTextColor: asString(fm.tabTextColor, '') || undefined,
    linkedFolders: toLinkedFolders(fm),
  };
}

/**
 * Linked folders, in all three shapes a real vault contains:
 *
 *   linkedFolder: Drawings                          one path
 *   linkedFolders: [Drawings, Notes]                the preferred inline list
 *   linkedFolders: Art|Drawings/Art;Refs|Refs       the legacy packed string
 *
 * The legacy form is one scalar carrying `Name|path` pairs separated by `;`. It has to
 * be understood here rather than in the parser: to YAML it is just a string, and only
 * this field knows it means more than that.
 */
function toLinkedFolders(fm: Record<string, unknown>): LinkedFolder[] {
  const entries: string[] = [];

  const single = asString(fm.linkedFolder, '');
  if (single) entries.push(single);

  const many = fm.linkedFolders;
  if (Array.isArray(many)) {
    for (const entry of many) if (typeof entry === 'string') entries.push(entry);
  } else if (typeof many === 'string') {
    entries.push(...many.split(';'));
  }

  const out: LinkedFolder[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const folder = toLinkedFolder(entry);
    if (!folder || seen.has(folder.path)) continue;
    seen.add(folder.path);
    out.push(folder);
  }
  return out;
}

function toLinkedFolder(entry: string): LinkedFolder | null {
  const text = entry.trim();
  if (!text) return null;

  const bar = text.indexOf('|');
  if (bar === -1) return { name: leafOf(text), path: text };

  const name = text.slice(0, bar).trim();
  const path = text.slice(bar + 1).trim();
  if (!path) return null;
  return { name: name || leafOf(path), path };
}

function leafOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

function toTask(doc: SourcedDocument, id: string, problems: LoadProblem[]): Task {
  const { frontmatter: fm, body, source } = doc;
  const deadline = asStringOrNull(fm.deadline);
  if (deadline && Number.isNaN(new Date(deadline).getTime())) {
    problems.push({
      code: 'bad-date',
      severity: 'warning',
      path: source.path,
      kind: 'task',
      id,
      detail: `deadline: ${deadline}`,
    });
  }
  return {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    projectId: projectReference(fm),
    status: asString(fm.status, 'running'),
    weight: asNumber(fm.weight, 1),
    orderIndex: asNumber(fm.orderIndex, 0),
    isFixedDuration: asBoolean(fm.isFixedDuration, false),
    fixedDuration: fm.fixedDuration === undefined ? null : asNumber(fm.fixedDuration, 0) || null,
    maxDuration: fm.maxDuration === undefined ? null : asNumber(fm.maxDuration, 0) || null,
    isCompleted: asBoolean(fm.isCompleted, false),
    createdAt: asString(fm.createdAt, EPOCH),
    startDate: asStringOrNull(fm.startDate),
    deadline,
    properties: {},
  };
}

function toEvent(doc: SourcedDocument, id: string, problems: LoadProblem[]): CalendarEvent {
  const { frontmatter: fm, body, source } = doc;
  const start = asString(fm.startDate, '');
  if (start && Number.isNaN(new Date(start).getTime())) {
    problems.push({
      code: 'bad-date',
      severity: 'warning',
      path: source.path,
      kind: 'event',
      id,
      detail: `startDate: ${start}`,
    });
  }
  return {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    projectId: projectReference(fm),
    createdAt: asString(fm.createdAt, EPOCH),
    startDate: start,
    deadline: asString(fm.deadline, start),
    isCompleted: asBoolean(fm.isCompleted, false),
    properties: {},
  };
}

/**
 * A task pointing at a project that did not load is a broken relationship, not an
 * uncategorised record — the distinction matters because the board would otherwise
 * quietly file it under "no project" and the creator would never learn the link broke.
 */
function reportMissingProjects(
  projects: Project[],
  tasks: Task[],
  events: CalendarEvent[],
  problems: LoadProblem[],
): void {
  const known = new Set(projects.map((p) => p.id));
  for (const record of [...tasks, ...events]) {
    if (record.projectId && !known.has(record.projectId)) {
      problems.push({
        code: 'missing-project',
        severity: 'warning',
        path: record.source.path,
        kind: record.source.kind,
        id: record.id,
        detail: `references project "${record.projectId}", which no loaded project has.`,
      });
    }
  }
}

/** Constant, not a clock read: a record with no createdAt has no time, not "now". */
const EPOCH = new Date(0).toISOString();
