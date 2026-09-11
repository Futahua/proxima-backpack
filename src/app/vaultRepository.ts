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
import { asString, asStringOrNull, parseDocument, type FrontmatterIssueCode } from '../domain/frontmatter.js';
import { DEFAULT_STATUSES, columnOf } from '../domain/elastic.js';
import { problemCodeForField, type LoadProblem } from '../domain/problems.js';
import {
  readBoolean,
  readDate,
  readDurationMinutes,
  readEnum,
  readOptionalDate,
  readOrderIndex,
  readStatus,
  readWeight,
  type FieldIssue,
} from '../domain/validation.js';
import type { IdOrigin, RecordKind, SourceRef } from '../domain/records.js';
import type { DirectoryPresence, VaultReader } from '../ports/vault.js';
import type {
  CalendarEvent,
  ElasticColumn,
  LinkedFolder,
  Project,
  ProximaState,
  Task,
} from '../domain/types.js';
import { declaredTypeVetoesProject, discoverFlatRecords, discoverProjects } from './discovery.js';
import { redactDiagnosticProblem } from './diagnostics.js';
import { directoryFor, resolveLayout, type VaultLayout } from './vaultLayout.js';

export interface LoadOptions {
  /** Root holding projects/, tasks/ and events/. Defaults to "Proxima". */
  root?: string;
  /** Per-directory overrides, for a vault that has been rearranged by hand. */
  layout?: Partial<VaultLayout>;
}

/**
 * One readable physical legacy record before logical-id deduplication.
 *
 * Compatibility state still refuses duplicate logical ids. Import planning needs the
 * physical candidates as separate provenance-bearing inputs so a collision cannot erase
 * one of the creator's files before migration has had a chance to account for it.
 */
export interface LegacyPhysicalRecordCandidate {
  readonly kind: RecordKind;
  readonly legacyId: string;
  readonly name: string;
  readonly projectId: string | null;
  readonly source: SourceRef;

  /**
   * Already-interpreted legacy values needed by the one-time importer.
   *
   * These values are produced by the same compatibility semantics used by ordinary
   * loading. They are import input only and do not become a second canonical model.
   */
  readonly compatibility: {
    readonly taskStatus:
      Task['status'] | null;
    readonly taskOrderIndex:
      Task['orderIndex'] | null;
    readonly taskExecutionState:
      ElasticColumn | null;
    readonly taskDescription:
      Task['description'] | null;
    readonly taskWeight:
      Task['weight'] | null;
    readonly taskIsFixedDuration:
      Task['isFixedDuration'] | null;
    readonly taskFixedDuration:
      Task['fixedDuration'] | null;
    readonly taskMaxDuration:
      Task['maxDuration'] | null;
    readonly taskIsCompleted:
      Task['isCompleted'] | null;
    readonly taskCreatedAt:
      Task['createdAt'] | null;
    readonly taskStartDate:
      Task['startDate'] | null;
    readonly taskDeadline:
      Task['deadline'] | null;
    readonly projectType:
      Project['projectType'] | null;
    readonly projectDescription:
      Project['description'] | null;
    readonly projectCreatedAt:
      Project['createdAt'] | null;
    readonly projectStatus:
      Project['status'] | null;
    readonly projectArchivedAt:
      string | null;
    /**
     * Already-interpreted legacy project/filesystem associations.
     *
     * These remain external-artifact import evidence. Paths do not become
     * canonical project identity.
     */
    readonly projectLinkedFolders:
      readonly LinkedFolder[] | null;
    /**
     * Already-parsed frontmatter used only as the lookup source for legacy custom
     * properties. Projects have no legacy property-value surface in this importer.
     */
    readonly propertyValues:
      Readonly<Record<string, unknown>> | null;
  };
}

export interface LoadResult {
  state: ProximaState;
  /** Everything the reader could not interpret, or interpreted with a caveat. */
  problems: LoadProblem[];
  /** Source path -> revision at load time, so external edits are detectable later. */
  revisions: Record<string, string>;
  /** The layout actually used, so a caller can report what it read. */
  layout: VaultLayout;
  /**
   * Readable, non-vetoed physical records before compatibility-state id deduplication.
   *
   * This is observational import input only. `state` retains the historical first-wins
   * duplicate refusal contract.
   */
  physicalCandidates: LegacyPhysicalRecordCandidate[];
  /**
   * What the transport actually saw, per record kind, and what became of it.
   *
   * A real run once reported PASS while every project silently vanished: the
   * transport failed to traverse one directory, 271 events from another kind kept
   * the total non-zero, and nothing anywhere noticed that a whole record class had
   * gone. Counting records is not enough — the question is whether the scan was
   * complete, and whether every candidate it found is accounted for.
   */
  census: Record<RecordKind, KindCensus>;
}

export interface KindCensus {
  /**
   * `complete` — the directory was traversed.
   * `absent` — it definitively is not there, which the layout contract permits.
   * `failed` — traversal did not finish, so what is in it is unknown. Blocking:
   *   "I could not look" is a different claim from "I looked and found nothing".
   */
  status: 'complete' | 'absent' | 'failed';
  /** Every file the scan returned, before discovery rules were applied. */
  scannedFiles: number;
  /** Files the discovery rules accepted as record-shaped. */
  recordCandidates: number;
  /** Candidates that became records. */
  loadedRecords: number;
  /** Candidates a reported problem explicitly accounts for. */
  explicitlyRejected: number;
  /**
   * Candidates that neither loaded nor were rejected for a stated reason. Any
   * non-zero value means a record disappeared without anyone saying why.
   */
  unaccountedCandidates: number;
}

/**
 * Problem codes that explain a candidate's absence from state.
 *
 * A warning on a record that did load — a defaulted enum, a missing relationship —
 * is not a rejection: that record is already counted as loaded. Only a candidate
 * that never became a record belongs here.
 */
const REJECTING_CODES = new Set(['unreadable', 'duplicate-id', 'unexpected-type']);

const FRONTMATTER_PARSE_FAILURE_CODES = new Set<FrontmatterIssueCode>([
  'unterminated-list',
  'unterminated-quote',
  'malformed-quote',
  'duplicate-key',
  'unparsable-line',
]);

function problemCodeForFrontmatterIssue(
  code: FrontmatterIssueCode,
): 'frontmatter-parse-failure' | 'unsupported-frontmatter' {
  return FRONTMATTER_PARSE_FAILURE_CODES.has(code)
    ? 'frontmatter-parse-failure'
    : 'unsupported-frontmatter';
}

function census(
  scan: KindScan,
  loadedRecords: number,
  rejections: LoadProblem[],
  kind: RecordKind,
): KindCensus {
  // Two phases produce rejections: discovery/read inside the scan, and identity
  // collisions when records are built. Both are candidate outcomes, so both count.
  const explicitlyRejected =
    scan.rejectedDuringScan +
    rejections.filter((problem) => problem.kind === kind && REJECTING_CODES.has(problem.code)).length;
  return {
    status: scan.status,
    scannedFiles: scan.scannedFiles,
    recordCandidates: scan.recordCandidates,
    loadedRecords,
    explicitlyRejected,
    unaccountedCandidates: Math.max(0, scan.recordCandidates - loadedRecords - explicitlyRejected),
  };
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

  const projectRead = await readKind(vault, layout, 'project', problems, revisions);
  const taskRead = await readKind(vault, layout, 'task', problems, revisions);
  const eventRead = await readKind(vault, layout, 'event', problems, revisions);

  const physicalCandidates = [
    ...projectRead.documents.map(toPhysicalCandidate),
    ...taskRead.documents.map(toPhysicalCandidate),
    ...eventRead.documents.map(toPhysicalCandidate),
  ];

  const before = problems.length;
  const projects = collect(projectRead.documents, problems, toProject);
  const tasks = collect(taskRead.documents, problems, toTask);
  const events = collect(eventRead.documents, problems, toEvent);
  const rejections = problems.slice(before);

  reportMissingProjects(projects, tasks, events, problems);

  return {
    state: { projects, tasks, events, statuses: DEFAULT_STATUSES, taskSchema: [] },
    problems: problems.map(redactDiagnosticProblem),
    revisions,
    layout,
    physicalCandidates,
    census: {
      project: census(projectRead.scan, projects.length, rejections, 'project'),
      task: census(taskRead.scan, tasks.length, rejections, 'task'),
      event: census(eventRead.scan, events.length, rejections, 'event'),
    },
  };
}

/** Read and parse every file the discovery rules accept for one record kind. */
async function readKind(
  vault: VaultReader,
  layout: VaultLayout,
  kind: RecordKind,
  problems: LoadProblem[],
  revisions: Record<string, string>,
): Promise<{ documents: SourcedDocument[]; scan: KindScan }> {
  const directory = directoryFor(layout, kind);

  let paths: string[];
  try {
    paths = await vault.walk(directory);
  } catch (error) {
    // A directory that is simply not there is a legal shape for a vault. One that
    // exists but could not be traversed is a hole in the evidence, and severity has
    // to say so: reporting it as a warning is how a whole record class once
    // vanished into a passing baseline.
    const presence = await directoryPresence(vault, directory);
    problems.push({
      code: 'directory-unreadable',
      severity: presence === 'missing' ? 'warning' : 'error',
      path: directory,
      kind,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      documents: [],
      scan: { status: presence === 'missing' ? 'absent' : 'failed', scannedFiles: 0, recordCandidates: 0, rejectedDuringScan: 0 },
    };
  }

  const discovery =
    kind === 'project'
      ? discoverProjects(paths, directory)
      : discoverFlatRecords(paths, directory, kind);
  problems.push(...discovery.problems);
  // Discovery's own vetoes are candidate outcomes, so they are accounted here.
  const scan: KindScan = {
    status: 'complete',
    scannedFiles: paths.length,
    recordCandidates: discovery.candidates.length,
    rejectedDuringScan: discovery.problems.filter((problem) => REJECTING_CODES.has(problem.code)).length,
  };

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
      scan.rejectedDuringScan += 1;
      continue;
    }

    revisions[candidate.path] = revision;
    const parsed = parseDocument(text);

    // Frontmatter the parser could not represent. The key is left unset rather than
    // filled with a guess, so the record still loads — with the field missing and a
    // problem saying which line made it missing.
    for (const issue of parsed.issues) {
      problems.push({
        code: problemCodeForFrontmatterIssue(issue.code),
        severity: 'warning',
        path: candidate.path,
        kind,
        detail: `line ${issue.line}${issue.key ? ` ("${issue.key}")` : ''}: ${issue.detail}`,
      });
    }

    // Only projects are vetoed by `type:`. On a task or an event it is ordinary
    // frontmatter — the plugin's loaders never read it — and treating it as a
    // discriminator would drop legacy records that carry an unrelated type.
    const declaredType = asString(parsed.frontmatter.type, '');
    if (kind === 'project' && declaredTypeVetoesProject(declaredType)) {
      problems.push({
        code: 'unexpected-type',
        severity: 'warning',
        path: candidate.path,
        kind,
        detail: `frontmatter says type: ${declaredType}, so it is not read as a project.`,
      });
      // A vetoed candidate never becomes a record, so it is accounted for here.
      // Counting it later from the shared problem array cannot work: this is pushed
      // before any post-scan snapshot, which is how it became a phantom
      // unaccounted candidate.
      scan.rejectedDuringScan += 1;
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

  return { documents, scan };
}

/** Scan facts readKind knows before the records are built. */
interface KindScan {
  status: 'complete' | 'absent' | 'failed';
  scannedFiles: number;
  recordCandidates: number;
  /**
   * Candidates this scan already accounted for — a file that could not be read, or
   * one discovery vetoed. Counted here rather than recovered later from the shared
   * problem array: those problems are pushed before any later snapshot, so a global
   * slice misses them and reports a phantom unaccounted candidate.
   */
  rejectedDuringScan: number;
}

/**
 * Tell "definitively not there" from "there but unreadable", after a traversal
 * failed — and refuse to guess when it cannot.
 *
 * Inferring absence from a second failed directory operation is what produced the
 * original false PASS in miniature: a permission-denied directory fails both `walk`
 * and `list`, and calling that "absent" downgrades a hole in the evidence to a
 * warning. So a reader that cannot answer precisely gets `unknown`, which the caller
 * treats as failed. Absence has to be proved, not assumed from silence.
 */
async function directoryPresence(vault: VaultReader, directory: string): Promise<DirectoryPresence> {
  const probe = (vault as VaultReader & { presence?: (path: string) => Promise<DirectoryPresence> }).presence;
  if (typeof probe !== 'function') return 'unknown';
  try {
    return await probe.call(vault, directory);
  } catch {
    return 'unknown';
  }
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

function toPhysicalCandidate(
  doc: SourcedDocument,
): LegacyPhysicalRecordCandidate {
  const legacyId =
    resolveId(doc);

  const source = {
    ...doc.source,
  };

  if (
    doc.source.kind
    === 'project'
  ) {
    const project =
      toProject(
        doc,
        legacyId,
        [],
      );

    return {
      kind: 'project',
      legacyId,
      name:
        project.name,
      projectId: null,
      source,
      compatibility: {
        taskStatus: null,
        taskOrderIndex:
          null,
        taskExecutionState:
          null,
        taskDescription:
          null,
        taskWeight:
          null,
        taskIsFixedDuration:
          null,
        taskFixedDuration:
          null,
        taskMaxDuration:
          null,
        taskIsCompleted:
          null,
        taskCreatedAt:
          null,
        taskStartDate:
          null,
        taskDeadline:
          null,
        projectType:
          project.projectType,
        projectDescription:
          project.description,
        projectCreatedAt:
          project.createdAt,
        projectStatus:
          project.status,
        projectArchivedAt:
          project.archivedAt
          ?? null,
        projectLinkedFolders:
          project.linkedFolders
            .map(
              (folder) => ({
                name:
                  folder.name,
                path:
                  folder.path,
              }),
            ),
        propertyValues:
          null,
      },
    };
  }

  if (
    doc.source.kind
    === 'task'
  ) {
    const task =
      toTask(
        doc,
        legacyId,
        [],
      );

    return {
      kind: 'task',
      legacyId,
      name:
        task.name,
      projectId:
        task.projectId,
      source,
      compatibility: {
        taskStatus:
          task.status,
        taskOrderIndex:
          task.orderIndex,
        taskExecutionState:
          columnOf(
            task,
            DEFAULT_STATUSES,
          ),
        taskDescription:
          task.description,
        taskWeight:
          task.weight,
        taskIsFixedDuration:
          task.isFixedDuration,
        taskFixedDuration:
          task.fixedDuration,
        taskMaxDuration:
          task.maxDuration,
        taskIsCompleted:
          task.isCompleted,
        taskCreatedAt:
          task.createdAt,
        taskStartDate:
          task.startDate,
        taskDeadline:
          task.deadline,
        projectType:
          null,
        projectDescription:
          null,
        projectCreatedAt:
          null,
        projectStatus:
          null,
        projectArchivedAt:
          null,
        projectLinkedFolders:
          null,
        propertyValues: {
          ...doc.frontmatter,
        },
      },
    };

  }

  return {
    kind: 'event',
    legacyId,
    name: displayName(
      doc.frontmatter,
      legacyId,
    ),
    projectId:
      projectReference(
        doc.frontmatter,
      ),
    source,
    compatibility: {
      taskStatus: null,
      taskOrderIndex:
        null,
      taskExecutionState:
        null,
      taskDescription:
        null,
      taskWeight:
        null,
      taskIsFixedDuration:
        null,
      taskFixedDuration:
        null,
      taskMaxDuration:
        null,
      taskIsCompleted:
        null,
      taskCreatedAt:
        null,
      taskStartDate:
        null,
      taskDeadline:
        null,
      projectType: null,
      projectDescription:
        null,
      projectCreatedAt:
        null,
      projectStatus:
        null,
      projectArchivedAt:
        null,
      projectLinkedFolders:
        null,
      propertyValues: {
        ...doc.frontmatter,
      },
    },
  };
}

function toProject(doc: SourcedDocument, id: string, problems: LoadProblem[]): Project {
  const { frontmatter: fm, body, source } = doc;
  const issues: FieldIssue[] = [];
  const archivedAt =
    readOptionalDate(
      fm.archivedAt,
      'archivedAt',
      issues,
    );
  const project: Project = {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    createdAt: readDate(fm.createdAt, 'createdAt', EPOCH, issues),
    status: readEnum(fm.status, 'status', ['active', 'archived'], 'active', issues),
    ...(archivedAt === null
      ? {}
      : { archivedAt }),
    projectType: readEnum(fm.projectType, 'projectType', ['task', 'schedule'], 'task', issues),
    tabBgColor: asString(fm.tabBgColor, '') || undefined,
    tabTextColor: asString(fm.tabTextColor, '') || undefined,
    linkedFolders: toLinkedFolders(fm),
  };
  reportFieldIssues(issues, source, id, problems);
  return project;
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
  const issues: FieldIssue[] = [];

  const isFixedDuration = readBoolean(fm.isFixedDuration, 'isFixedDuration', false, issues);
  const fixedDuration = readDurationMinutes(fm.fixedDuration, 'fixedDuration', issues);

  // A task flagged fixed with no usable duration has nothing to reserve. It stretches
  // like any other, which is what the timeline already does with it — but silently,
  // so the flag is worth reporting rather than quietly ignoring.
  if (isFixedDuration && fixedDuration === null) {
    issues.push({
      field: 'fixedDuration',
      code: 'out-of-range',
      detail: 'isFixedDuration is true but no usable fixedDuration is set; the task stretches.',
    });
  }

  const task: Task = {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    projectId: projectReference(fm),
    status: readStatus(fm.status, 'running', issues),
    weight: readWeight(fm.weight, issues),
    orderIndex: readOrderIndex(fm.orderIndex, issues),
    isFixedDuration,
    fixedDuration,
    maxDuration: readDurationMinutes(fm.maxDuration, 'maxDuration', issues),
    isCompleted: readBoolean(fm.isCompleted, 'isCompleted', false, issues),
    createdAt: readDate(fm.createdAt, 'createdAt', EPOCH, issues),
    startDate: readOptionalDate(fm.startDate, 'startDate', issues),
    deadline: readOptionalDate(fm.deadline, 'deadline', issues),
    properties: {},
  };

  reportFieldIssues(issues, source, id, problems);
  return task;
}

function toEvent(doc: SourcedDocument, id: string, problems: LoadProblem[]): CalendarEvent {
  const { frontmatter: fm, body, source } = doc;
  const issues: FieldIssue[] = [];

  const start = readOptionalDate(fm.startDate, 'startDate', issues);
  const deadline = readOptionalDate(fm.deadline, 'deadline', issues);

  const event: CalendarEvent = {
    id,
    source,
    name: displayName(fm, id),
    description: asString(fm.description, body),
    projectId: projectReference(fm),
    createdAt: readDate(fm.createdAt, 'createdAt', EPOCH, issues),
    startDate: start ?? '',
    deadline: deadline ?? start ?? '',
    isCompleted: readBoolean(fm.isCompleted, 'isCompleted', false, issues),
    properties: {},
  };

  reportFieldIssues(issues, source, id, problems);
  return event;
}

/** Field-level validation issues become ordinary load problems, keyed to the record. */
function reportFieldIssues(
  issues: FieldIssue[],
  source: SourceRef,
  id: string,
  problems: LoadProblem[],
): void {
  for (const issue of issues) {
    problems.push({
      code: problemCodeForField(issue.code),
      severity: 'warning',
      path: source.path,
      kind: source.kind,
      id,
      detail: `${issue.field}: ${issue.detail}`,
    });
  }
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
