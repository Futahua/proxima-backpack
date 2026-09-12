/**
 * Canonical records → the UI's readable world.
 *
 * HARD GATE C's fifth item asks that the UI not care whether state came from legacy
 * Markdown or from the Proxima record store. Today it cannot: every surface reads
 * `ProximaState`, while the record store holds `CanonicalRecordV2` records. This is the
 * projection between them, and it is deliberately a *compatibility* projection — it says
 * what each canonical record means in the shape the existing surfaces already render, and
 * it reports everything that shape cannot carry rather than dropping it.
 *
 * Two things it refuses to invent:
 *
 * - a project's legacy `projectType`, which HARD GATE A4 removed from capability decisions.
 *   It is reconstructed from what the project actually holds so nothing downstream reads a
 *   stale label as a capability;
 * - a workflow stage's place in `ProximaState`, which has none. Stage records are counted
 *   and reported as unrepresented instead, because A2 keeps project workflow and Elastic
 *   execution independent and the board's columns are the execution states.
 *
 * Nothing here writes. It takes observations the store already made.
 */
import type { CanonicalRecordKind, OpaqueRecordId } from '../domain/canonicalIdentity.js';
import {
  type CanonicalEventRecordV2,
  type CanonicalProjectRecordV2,
  type CanonicalRecordV2,
  type CanonicalStoredPropertyValue,
  type CanonicalTaskRecordV2,
} from '../domain/canonicalRecordV2.js';
import type { CanonicalPropertyDefinition, CanonicalPropertySchemaRecord } from '../domain/canonicalSchema.js';
import type { CanonicalExecutionState, CanonicalWorkflowStageStateRecord } from '../domain/canonicalTaskState.js';
import type { CanonicalRecurrenceSeries } from '../domain/canonicalRecurrence.js';
import type { SourceRef } from '../domain/records.js';
import type {
  CalendarEvent,
  Project,
  PropertySchema,
  ProximaState,
  SelectOption,
  StatusDefinition,
  Task,
  WorkflowStage,
} from '../domain/types.js';
import type { RecordStoreObservation } from '../ports/recordStore.js';

export const RECORD_STATE_PROJECTION_VERSION = 1 as const;

/**
 * The three execution states the canonical model defines, as board columns.
 *
 * The legacy `DEFAULT_STATUSES` list is not used: its ids are a vault's vocabulary, and a
 * record-store state has the canonical vocabulary instead. Column and id are the same word
 * here because A2's execution state *is* the Elastic column.
 */
export const EXECUTION_STATE_STATUSES: readonly StatusDefinition[] = [
  { id: 'backlog', name: 'Backlog', color: '#636e72', column: 'backlog' },
  { id: 'running', name: 'Running', color: '#00b894', column: 'running' },
  { id: 'finished', name: 'Finished', color: '#fdcb6e', column: 'finished' },
];

export type RecordStateProjectionGapReason =
  | 'workflow-stage-project-missing'
  | 'task-workflow-stage-missing'
  | 'artifact-binding-not-resolvable-from-records'
  | 'property-option-not-in-schema'
  | 'property-value-not-representable'
  | 'recurrence-rule-not-representable';

export interface RecordStateProjectionGap {
  readonly kind: CanonicalRecordKind;
  readonly id: string;
  readonly reason: RecordStateProjectionGapReason;
  readonly detail: string;
}

export interface RecordStateProjectionReport {
  readonly schemaVersion: typeof RECORD_STATE_PROJECTION_VERSION;
  readonly source: 'proxima-record-store';
  readonly consumed: Readonly<Record<CanonicalRecordKind, number>>;
  /** Record id → the revision the store reported, so a caller can detect changes later. */
  readonly revisions: Readonly<Record<string, string>>;
  readonly gaps: readonly RecordStateProjectionGap[];
}

export interface RecordStateProjection {
  readonly state: ProximaState;
  readonly report: RecordStateProjectionReport;
}

function recordStoreSource(
  record: CanonicalProjectRecordV2 | CanonicalTaskRecordV2 | CanonicalEventRecordV2,
  observedRevision: string,
): SourceRef {
  return {
    // A canonical record has no vault file to name, so the opaque record id is the honest
    // value here and `idOrigin` says so.
    path: record.id,
    revision: observedRevision,
    kind: record.kind,
    idOrigin: 'record-store',
  };
}

function optionLabels(schemas: readonly CanonicalPropertySchemaRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const schema of schemas) {
    const definition = schema.definition;
    if (definition.type === 'select' || definition.type === 'multi-select') {
      for (const option of definition.options) labels.set(option.id, option.label);
    }
  }
  return labels;
}

function selectOptions(definition: CanonicalPropertyDefinition): SelectOption[] | undefined {
  if (definition.type !== 'select' && definition.type !== 'multi-select') return undefined;
  return definition.options.map((option) => ({
    id: option.id,
    name: option.label,
    // Option colour is local presentation state under A5, so a canonical record does not
    // carry one and the projection does not invent it.
    color: '',
  }));
}

function propertySchemaFor(record: CanonicalPropertySchemaRecord): PropertySchema {
  const definition = record.definition;
  const base: PropertySchema = {
    id: record.id,
    name: record.name,
    type: definition.type,
  };
  const options = selectOptions(definition);
  if (options) return { ...base, options };
  if (definition.type === 'rollup') {
    return {
      ...base,
      relationProperty: definition.relationSchemaId,
      targetProperty: definition.targetSchemaId,
      aggregation: definition.aggregation,
    };
  }
  if (definition.type === 'formula') return { ...base, expression: definition.expression };
  return base;
}

function legacyPropertyValue(
  value: CanonicalStoredPropertyValue,
  labels: ReadonlyMap<string, string>,
  gaps: RecordStateProjectionGap[],
  kind: CanonicalRecordKind,
  recordId: string,
  propertyKey: string,
): unknown {
  switch (value.type) {
    case 'text':
    case 'number':
    case 'date':
    case 'checkbox':
      return value.value;
    case 'select': {
      const label = labels.get(value.optionId);
      if (label === undefined) {
        gaps.push({
          kind,
          id: recordId,
          reason: 'property-option-not-in-schema',
          detail: `${propertyKey}: option ${value.optionId} has no schema record to name it`,
        });
        return value.optionId;
      }
      return label;
    }
    case 'multi-select': {
      return value.optionIds.map((optionId) => {
        const label = labels.get(optionId);
        if (label === undefined) {
          gaps.push({
            kind,
            id: recordId,
            reason: 'property-option-not-in-schema',
            detail: `${propertyKey}: option ${optionId} has no schema record to name it`,
          });
          return optionId;
        }
        return label;
      });
    }
    case 'relation':
      // Relations are canonical identity, and the legacy shape stores a plain value, so the
      // target record ids are what fits. They are ids on purpose: a relation that rendered a
      // name would be a name that drifts from the record it points at.
      return value.value.targetRecordIds.length === 1
        ? value.value.targetRecordIds[0]
        : [...value.value.targetRecordIds];
    default: {
      gaps.push({
        kind,
        id: recordId,
        reason: 'property-value-not-representable',
        detail: propertyKey,
      });
      return null;
    }
  }
}

function legacyProperties(
  values: CanonicalTaskRecordV2['properties'],
  labels: ReadonlyMap<string, string>,
  gaps: RecordStateProjectionGap[],
  kind: CanonicalRecordKind,
  recordId: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) {
    const value = values[key]!;
    properties[key] = legacyPropertyValue(value, labels, gaps, kind, recordId, key);
  }
  return properties;
}

function taskFrom(
  record: CanonicalTaskRecordV2,
  revisions: Readonly<Record<string, string>>,
  labels: ReadonlyMap<string, string>,
  gaps: RecordStateProjectionGap[],
): Task {
  return {
    id: record.id,
    source: recordStoreSource(record, revisions[record.id] ?? ''),
    name: record.name,
    description: record.description,
    projectId: record.projectId,
    // The legacy status field is the execution state, which is what the Elastic board and
    // the Task Board group by. The workflow stage stays where A2 put it — reported as a gap.
    status: record.executionState,
    weight: record.weight,
    orderIndex: record.executionOrder,
    isFixedDuration: record.isFixedDuration,
    fixedDuration: record.fixedDuration,
    maxDuration: record.maxDuration,
    isCompleted: record.isCompleted,
    createdAt: record.createdAt,
    startDate: record.startDate,
    deadline: record.deadline,
    properties: {
      ...legacyProperties(record.properties, labels, gaps, 'task', record.id),
      ...recurrenceProperties(record.recurrence, gaps, record.id, 'task'),
    },
    // The workflow dimension travels with the task rather than replacing the execution one: a task
    // in Review is still Running, and that is A2 stated as two fields instead of one.
    workflowStageId: record.workflowStageId,
    workflowOrder: record.workflowOrder,
  };
}

/**
 * A canonical recurrence series as the readable world carries it.
 *
 * Two keys, because the two readers want different things. `recurrence` is the **rule** in the
 * vocabulary the schedule already reads (`frequency`, `interval`, `count`, `until`), so the
 * projections expand a record-store series exactly as they expand a legacy one. `recurrenceSeries`
 * is the canonical series itself — its id and its exceptions — which is what an occurrence-scoped
 * write needs and what the schedule reads to skip a cancelled occurrence or honour a rescheduled one.
 *
 * A rule this vocabulary cannot express is **reported rather than dropped**: a series that vanished
 * silently would look like an event that no longer recurs, which is a different fact.
 */
function recurrenceProperties(
  series: CanonicalRecurrenceSeries | null,
  gaps: RecordStateProjectionGap[],
  recordId: string,
  kind: 'task' | 'event',
): Record<string, unknown> {
  if (series === null) return {};
  const rule = series.rule;
  if (rule.frequency === 'weekly' && rule.weekdays.length !== 1) {
    gaps.push({
      kind,
      id: recordId,
      reason: 'recurrence-rule-not-representable',
      detail: `series ${series.seriesId} recurs on ${rule.weekdays.length} weekdays, which the readable rule cannot carry`,
    });
    // The record says so as well as the gap list, because a surface has to be able to tell "does not recur" from
    // "recurs in a way this vocabulary cannot show": an editor that read the silence as the first would clear the
    // rule on its next save. The gap is for the diagnostics; this is for the surface.
    return { recurrenceUnreadable: true };
  }

  return {
    recurrence: {
      frequency: rule.frequency,
      interval: rule.interval,
      ...(rule.frequency === 'weekly' ? { weekdays: [...rule.weekdays] } : {}),
      ...(rule.frequency === 'monthly' ? { dayOfMonth: rule.dayOfMonth } : {}),
      ...(rule.frequency === 'yearly' ? { month: rule.month, dayOfMonth: rule.dayOfMonth } : {}),
      ...(rule.end.kind === 'count' ? { count: rule.end.count } : {}),
      ...(rule.end.kind === 'until' ? { until: rule.end.until } : {}),
    },
    // The canonical rule travels too, because the planner that decides whether an override names a
    // generated slot needs the rule's own vocabulary rather than the readable one.
    recurrenceRule: {
      frequency: rule.frequency,
      interval: rule.interval,
      ...(rule.frequency === 'weekly' ? { weekdays: [...rule.weekdays] } : {}),
      ...(rule.frequency === 'monthly' ? { dayOfMonth: rule.dayOfMonth } : {}),
      ...(rule.frequency === 'yearly' ? { month: rule.month, dayOfMonth: rule.dayOfMonth } : {}),
      end: { ...rule.end },
    },
    recurrenceSeries: {
      seriesId: series.seriesId,
      exceptions: series.exceptions.map((exception) => ({ ...exception, occurrence: { ...exception.occurrence } })),
    },
  };
}

function eventFrom(
  record: CanonicalEventRecordV2,
  revisions: Readonly<Record<string, string>>,
  labels: ReadonlyMap<string, string>,
  gaps: RecordStateProjectionGap[],
): CalendarEvent {
  return {
    id: record.id,
    source: recordStoreSource(record, revisions[record.id] ?? ''),
    name: record.name,
    description: record.description,
    projectId: record.projectId,
    createdAt: record.createdAt,
    startDate: record.startDate,
    deadline: record.deadline,
    isCompleted: record.isCompleted,
    properties: {
      ...legacyProperties(record.properties, labels, gaps, 'event', record.id),
      ...recurrenceProperties(record.recurrence, gaps, record.id, 'event'),
    },
  };
}

function projectFrom(
  record: CanonicalProjectRecordV2,
  revisions: Readonly<Record<string, string>>,
  holdsTasks: boolean,
  holdsEvents: boolean,
  gaps: RecordStateProjectionGap[],
): Project {
  // A4 removed the legacy label from capability decisions, so it is reconstructed from what
  // the project actually holds rather than carried as a stale claim. Nothing downstream may
  // read this as a capability again; that is why it is derived here and not stored.
  const projectType: Project['projectType'] = holdsTasks || !holdsEvents ? 'task' : 'schedule';
  for (const binding of record.artifactBindings) {
    gaps.push({
      kind: 'project',
      id: record.id,
      reason: 'artifact-binding-not-resolvable-from-records',
      detail: `artifact ${binding.artifactId} (${binding.role}) is bound but its locator is not a record`,
    });
  }
  return {
    id: record.id,
    source: recordStoreSource(record, revisions[record.id] ?? ''),
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    status: record.status,
    projectType,
    ...(record.archivedAt === null ? {} : { archivedAt: record.archivedAt }),
    // A8 keeps project/filesystem association in explicit external-artifact references, so
    // there are no linked folders to read off a record.
    linkedFolders: [],
  };
}

/**
 * Project store observations into the readable world the surfaces render.
 *
 * Deterministic: every list is ordered by record id, so two runs over the same store
 * produce the same state and the same report.
 */
export function projectRecordState(
  observations: readonly RecordStoreObservation<CanonicalRecordV2>[],
): RecordStateProjection {
  const revisions: Record<string, string> = {};
  const consumed: Record<CanonicalRecordKind, number> = {
    project: 0,
    task: 0,
    event: 0,
    schema: 0,
    'workflow-stage': 0,
  };
  const gaps: RecordStateProjectionGap[] = [];

  const ordered = [...observations].sort((left, right) => left.id.localeCompare(right.id));
  for (const observation of ordered) revisions[observation.id] = observation.observedRevision;

  const schemaRecords = ordered
    .map((observation) => observation.record)
    .filter((record): record is CanonicalPropertySchemaRecord => record.kind === 'schema');
  const labels = optionLabels(schemaRecords);

  const projectRecords = ordered
    .map((observation) => observation.record)
    .filter((record): record is CanonicalProjectRecordV2 => record.kind === 'project');
  const taskRecords = ordered
    .map((observation) => observation.record)
    .filter((record): record is CanonicalTaskRecordV2 => record.kind === 'task');
  const eventRecords = ordered
    .map((observation) => observation.record)
    .filter((record): record is CanonicalEventRecordV2 => record.kind === 'event');

  const tasks = taskRecords.map((record) => taskFrom(record, revisions, labels, gaps));
  const events = eventRecords.map((record) => eventFrom(record, revisions, labels, gaps));
  const projects = projectRecords.map((record) => projectFrom(
    record,
    revisions,
    tasks.some((task) => task.projectId === record.id),
    events.some((event) => event.projectId === record.id),
    gaps,
  ));

  for (const observation of ordered) consumed[observation.record.kind] += 1;

  // The workflow dimension, as its own list in the readable world. It is deliberately *not* folded
  // into `statuses`: A2 keeps the project workflow and the Elastic execution state independent, and
  // a board that read one as the other would be the silo this gate removed. Two things are still
  // reported rather than invented — a stage whose project is not in the store, and a task naming a
  // stage that is not — because either would otherwise render as an empty column or a lost card.
  const stageRecords = ordered
    .map((observation) => observation.record)
    .filter((record): record is CanonicalWorkflowStageStateRecord => record.kind === 'workflow-stage');
  const stageIds = new Set(stageRecords.map((record) => record.id as string));

  for (const record of stageRecords) {
    if (!projectRecords.some((project) => project.id === record.projectId)) {
      gaps.push({
        kind: 'workflow-stage',
        id: record.id,
        reason: 'workflow-stage-project-missing',
        detail: `stage ${record.name} belongs to project ${record.projectId}, which is not in the store`,
      });
    }
  }
  for (const record of taskRecords) {
    if (record.workflowStageId !== null && !stageIds.has(record.workflowStageId)) {
      gaps.push({
        kind: 'task',
        id: record.id,
        reason: 'task-workflow-stage-missing',
        detail: `task ${record.name} is in stage ${record.workflowStageId}, which is not in the store`,
      });
    }
  }

  const workflowStages: WorkflowStage[] = stageRecords.map((record) => ({
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    revision: revisions[record.id] ?? '',
  }));

  return {
    state: {
      projects,
      tasks,
      events,
      statuses: [...EXECUTION_STATE_STATUSES],
      taskSchema: schemaRecords.map(propertySchemaFor),
      workflowStages,
    },
    report: {
      schemaVersion: RECORD_STATE_PROJECTION_VERSION,
      source: 'proxima-record-store',
      consumed,
      revisions,
      gaps: gaps.sort((left, right) => (
        left.kind.localeCompare(right.kind)
        || left.id.localeCompare(right.id)
        || left.reason.localeCompare(right.reason)
      )),
    },
  };
}

/** The execution state a projected task reports, for callers that need it back. */
export function executionStateOf(task: Task): CanonicalExecutionState {
  return task.status === 'running' || task.status === 'finished' ? task.status : 'backlog';
}

/** True when every record in a projection came from the record store rather than a file. */
export function isRecordStoreState(state: ProximaState): boolean {
  const sources: SourceRef[] = [
    ...state.projects.map((project) => project.source),
    ...state.tasks.map((task) => task.source),
    ...state.events.map((event) => event.source),
  ];
  return sources.length > 0 && sources.every((source) => source.idOrigin === 'record-store');
}

/** Ids the projection dropped or could not carry, for a caller that wants to refuse a run. */
export function gapIds(report: RecordStateProjectionReport): OpaqueRecordId[] {
  return [...new Set(report.gaps.map((gap) => gap.id))] as OpaqueRecordId[];
}
