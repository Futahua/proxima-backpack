import {
  defineProjectArtifactAssociations,
  parseOpaqueExternalArtifactId,
  type ProjectArtifactBinding,
  type ProjectArtifactRole,
} from './canonicalArtifactAssociation.js';
import {
  CANONICAL_RECORD_SCHEMA_VERSION,
  defineCanonicalRecordHeader,
  parseOpaqueRecordId,
  type CanonicalRecordHeader,
  type CanonicalRecordKind,
  type OpaqueRecordId,
} from './canonicalIdentity.js';
import {
  canonicalOrderPosition,
  type CanonicalChronologicalEventRecord,
  type CanonicalOrderedTaskRecord,
} from './canonicalOrdering.js';
import {
  defineCanonicalRecurrenceSeries,
  parseOpaqueRecurrenceSeriesId,
  type CanonicalOccurrenceIdentity,
  type CanonicalRecurrenceEnd,
  type CanonicalRecurrenceException,
  type CanonicalRecurrenceRule,
  type CanonicalRecurrenceSeries,
  type CanonicalRecurrenceWeekday,
} from './canonicalRecurrence.js';
import {
  defineCanonicalRelationValue,
  type CanonicalRelationValue,
} from './canonicalRelation.js';
import {
  defineCanonicalPropertySchema,
  parseOpaqueSchemaOptionId,
  type CanonicalPropertyDefinition,
  type CanonicalPropertySchemaRecord,
  type CanonicalRelatableRecordKind,
  type CanonicalRollupAggregation,
  type CanonicalSelectOption,
  type OpaqueSchemaOptionId,
} from './canonicalSchema.js';
import type {
  CanonicalExecutionState,
  CanonicalWorkflowStageStateRecord,
} from './canonicalTaskState.js';

export type CanonicalProjectLifecycleState = 'active' | 'archived';

export type CanonicalStoredPropertyValue =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'date'; readonly value: string }
  | { readonly type: 'checkbox'; readonly value: boolean }
  | { readonly type: 'select'; readonly optionId: OpaqueSchemaOptionId }
  | { readonly type: 'multi-select'; readonly optionIds: readonly OpaqueSchemaOptionId[] }
  | { readonly type: 'relation'; readonly value: CanonicalRelationValue };

export type CanonicalStoredPropertyValues = Readonly<
  Record<string, CanonicalStoredPropertyValue>
>;

export interface CanonicalTaskRecordV2
  extends CanonicalOrderedTaskRecord {
  readonly description: string;
  readonly weight: number;
  readonly isFixedDuration: boolean;
  readonly fixedDuration: number | null;
  readonly maxDuration: number | null;
  readonly isCompleted: boolean;
  readonly createdAt: string;
  readonly startDate: string | null;
  readonly deadline: string | null;
  readonly properties: CanonicalStoredPropertyValues;
  readonly recurrence: CanonicalRecurrenceSeries | null;
}

export interface CanonicalProjectRecordV2
  extends CanonicalRecordHeader<'project'> {
  readonly description: string;
  readonly createdAt: string;
  readonly status: CanonicalProjectLifecycleState;
  readonly archivedAt: string | null;
  readonly artifactBindings: readonly ProjectArtifactBinding[];
}

export interface CanonicalEventRecordV2
  extends CanonicalChronologicalEventRecord {
  readonly description: string;
  readonly projectId: OpaqueRecordId | null;
  readonly createdAt: string;
  readonly isCompleted: boolean;
  readonly properties: CanonicalStoredPropertyValues;
  readonly recurrence: CanonicalRecurrenceSeries | null;
}

export type CanonicalRecordV2 =
  | CanonicalTaskRecordV2
  | CanonicalProjectRecordV2
  | CanonicalEventRecordV2
  | CanonicalPropertySchemaRecord
  | CanonicalWorkflowStageStateRecord;

const RECORD_KINDS = new Set<CanonicalRecordKind>([
  'task',
  'project',
  'event',
  'schema',
  'workflow-stage',
]);
const EXECUTION_STATES = new Set<CanonicalExecutionState>([
  'backlog',
  'running',
  'finished',
]);
const PROJECT_STATES = new Set<CanonicalProjectLifecycleState>([
  'active',
  'archived',
]);
const ARTIFACT_ROLES = new Set<ProjectArtifactRole>([
  'notes-root',
  'drawings-root',
  'attachments-root',
  'artifact',
]);
const RELATABLE_KINDS = new Set<CanonicalRelatableRecordKind>([
  'task',
  'project',
  'event',
]);
const ROLLUP_AGGREGATIONS = new Set<CanonicalRollupAggregation>([
  'sum',
  'average',
  'count',
  'unique',
  'min',
  'max',
]);
const RECURRENCE_WEEKDAYS = new Set<CanonicalRecurrenceWeekday>([
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
]);

function objectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

function stringValue(
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function booleanValue(
  value: unknown,
  label: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function dateValue(
  value: unknown,
  label: string,
): string {
  const text = stringValue(value, label);
  if (
    text.trim() === ''
    || !Number.isFinite(Date.parse(text))
  ) {
    throw new Error(`${label} must be a readable date.`);
  }
  return text;
}

function optionalDateValue(
  value: unknown,
  label: string,
): string | null {
  return value === null
    ? null
    : dateValue(value, label);
}

function positiveNumber(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
  ) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return value;
}

function optionalPositiveNumber(
  value: unknown,
  label: string,
): number | null {
  return value === null
    ? null
    : positiveNumber(value, label);
}

function recordIdValue(
  value: unknown,
  label: string,
): OpaqueRecordId {
  return parseOpaqueRecordId(stringValue(value, label));
}

function optionalRecordIdValue(
  value: unknown,
  label: string,
): OpaqueRecordId | null {
  return value === null
    ? null
    : recordIdValue(value, label);
}

function headerValue<K extends CanonicalRecordKind>(
  value: Record<string, unknown>,
  kind: K,
): CanonicalRecordHeader<K> {
  if (value.schemaVersion !== CANONICAL_RECORD_SCHEMA_VERSION) {
    throw new Error('Canonical record schemaVersion is unsupported.');
  }
  if (value.kind !== kind) {
    throw new Error(`Canonical record kind must be ${kind}.`);
  }
  return defineCanonicalRecordHeader({
    kind,
    id: recordIdValue(value.id, 'Canonical record id'),
    name: stringValue(value.name, 'Canonical record name'),
  });
}

function decodePropertyValues(
  value: unknown,
): CanonicalStoredPropertyValues {
  const properties = objectValue(
    value,
    'Canonical property values',
  );
  const result: Record<string, CanonicalStoredPropertyValue> = {};

  for (const [rawSchemaId, rawValue] of Object.entries(properties)) {
    const schemaId = parseOpaqueRecordId(rawSchemaId);
    const item = objectValue(
      rawValue,
      `Canonical property ${schemaId}`,
    );
    const type = stringValue(
      item.type,
      `Canonical property ${schemaId} type`,
    );

    switch (type) {
      case 'text':
        exactKeys(item, ['type', 'value'], `Canonical text property ${schemaId}`);
        result[schemaId] = {
          type: 'text',
          value: stringValue(item.value, `Canonical text property ${schemaId} value`),
        };
        break;
      case 'number':
        exactKeys(item, ['type', 'value'], `Canonical number property ${schemaId}`);
        if (
          typeof item.value !== 'number'
          || !Number.isFinite(item.value)
        ) {
          throw new Error(`Canonical number property ${schemaId} must be finite.`);
        }
        result[schemaId] = {
          type: 'number',
          value: item.value,
        };
        break;
      case 'date':
        exactKeys(item, ['type', 'value'], `Canonical date property ${schemaId}`);
        result[schemaId] = {
          type: 'date',
          value: dateValue(item.value, `Canonical date property ${schemaId} value`),
        };
        break;
      case 'checkbox':
        exactKeys(item, ['type', 'value'], `Canonical checkbox property ${schemaId}`);
        result[schemaId] = {
          type: 'checkbox',
          value: booleanValue(item.value, `Canonical checkbox property ${schemaId} value`),
        };
        break;
      case 'select':
        exactKeys(item, ['type', 'optionId'], `Canonical select property ${schemaId}`);
        result[schemaId] = {
          type: 'select',
          optionId: parseOpaqueSchemaOptionId(
            stringValue(item.optionId, `Canonical select property ${schemaId} option`),
          ),
        };
        break;
      case 'multi-select': {
        exactKeys(item, ['type', 'optionIds'], `Canonical multi-select property ${schemaId}`);
        if (!Array.isArray(item.optionIds)) {
          throw new Error(`Canonical multi-select property ${schemaId} optionIds must be an array.`);
        }
        const optionIds = item.optionIds.map((optionId) =>
          parseOpaqueSchemaOptionId(
            stringValue(optionId, `Canonical multi-select property ${schemaId} option`),
          ));
        if (new Set(optionIds).size !== optionIds.length) {
          throw new Error(`Canonical multi-select property ${schemaId} contains a duplicate option.`);
        }
        result[schemaId] = {
          type: 'multi-select',
          optionIds,
        };
        break;
      }
      case 'relation': {
        exactKeys(item, ['type', 'value'], `Canonical relation property ${schemaId}`);
        const relation = objectValue(
          item.value,
          `Canonical relation property ${schemaId} value`,
        );
        exactKeys(
          relation,
          ['relationSchemaId', 'targetRecordIds'],
          `Canonical relation property ${schemaId} value`,
        );
        if (!Array.isArray(relation.targetRecordIds)) {
          throw new Error(`Canonical relation property ${schemaId} targets must be an array.`);
        }
        const relationValue = defineCanonicalRelationValue({
          relationSchemaId: recordIdValue(
            relation.relationSchemaId,
            `Canonical relation property ${schemaId} relationSchemaId`,
          ),
          targetRecordIds: relation.targetRecordIds.map((targetId) =>
            recordIdValue(
              targetId,
              `Canonical relation property ${schemaId} target id`,
            )),
        });
        if (relationValue.relationSchemaId !== schemaId) {
          throw new Error(
            `Canonical relation property key ${schemaId} does not match relationSchemaId ${relationValue.relationSchemaId}.`,
          );
        }
        result[schemaId] = {
          type: 'relation',
          value: relationValue,
        };
        break;
      }
      default:
        throw new Error(`Unknown canonical stored property type: ${type}`);
    }
  }

  return result;
}

function decodeOccurrence(
  value: unknown,
  label: string,
): CanonicalOccurrenceIdentity {
  const item = objectValue(value, label);
  exactKeys(item, ['seriesId', 'scheduledStart'], label);
  return {
    seriesId: parseOpaqueRecurrenceSeriesId(
      stringValue(item.seriesId, `${label} seriesId`),
    ),
    scheduledStart: dateValue(
      item.scheduledStart,
      `${label} scheduledStart`,
    ),
  };
}

function decodeRecurrenceEnd(
  value: unknown,
): CanonicalRecurrenceEnd {
  const item = objectValue(value, 'Canonical recurrence end');
  const kind = stringValue(item.kind, 'Canonical recurrence end kind');

  switch (kind) {
    case 'never':
      exactKeys(item, ['kind'], 'Canonical recurrence end');
      return { kind: 'never' };
    case 'until':
      exactKeys(item, ['kind', 'until'], 'Canonical recurrence end');
      return {
        kind: 'until',
        until: dateValue(item.until, 'Canonical recurrence until'),
      };
    case 'count':
      exactKeys(item, ['kind', 'count'], 'Canonical recurrence end');
      if (
        typeof item.count !== 'number'
        || !Number.isSafeInteger(item.count)
        || item.count < 1
      ) {
        throw new Error('Canonical recurrence count must be a positive safe integer.');
      }
      return { kind: 'count', count: item.count };
    default:
      throw new Error(`Unknown canonical recurrence end kind: ${kind}`);
  }
}

function positiveSafeInteger(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function decodeRecurrenceRule(
  value: unknown,
): CanonicalRecurrenceRule {
  const item = objectValue(value, 'Canonical recurrence rule');
  const frequency = stringValue(
    item.frequency,
    'Canonical recurrence frequency',
  );
  const interval = positiveSafeInteger(
    item.interval,
    'Canonical recurrence interval',
  );
  const end = decodeRecurrenceEnd(item.end);

  switch (frequency) {
    case 'daily':
      exactKeys(
        item,
        ['frequency', 'interval', 'end'],
        'Canonical daily recurrence rule',
      );
      return { frequency: 'daily', interval, end };
    case 'weekly': {
      exactKeys(
        item,
        ['frequency', 'interval', 'weekdays', 'end'],
        'Canonical weekly recurrence rule',
      );
      if (!Array.isArray(item.weekdays) || item.weekdays.length === 0) {
        throw new Error('Canonical weekly recurrence weekdays must be a non-empty array.');
      }
      const weekdays = item.weekdays.map((weekday) => {
        const checked = stringValue(weekday, 'Canonical recurrence weekday');
        if (!RECURRENCE_WEEKDAYS.has(checked as CanonicalRecurrenceWeekday)) {
          throw new Error(`Unknown canonical recurrence weekday: ${checked}`);
        }
        return checked as CanonicalRecurrenceWeekday;
      });
      if (new Set(weekdays).size !== weekdays.length) {
        throw new Error('Canonical weekly recurrence contains a duplicate weekday.');
      }
      return { frequency: 'weekly', interval, weekdays, end };
    }
    case 'monthly': {
      exactKeys(
        item,
        ['frequency', 'interval', 'dayOfMonth', 'end'],
        'Canonical monthly recurrence rule',
      );
      const dayOfMonth = positiveSafeInteger(
        item.dayOfMonth,
        'Canonical recurrence dayOfMonth',
      );
      if (dayOfMonth > 31) {
        throw new Error('Canonical recurrence dayOfMonth must be between 1 and 31.');
      }
      return { frequency: 'monthly', interval, dayOfMonth, end };
    }
    case 'yearly': {
      exactKeys(
        item,
        ['frequency', 'interval', 'month', 'dayOfMonth', 'end'],
        'Canonical yearly recurrence rule',
      );
      const month = positiveSafeInteger(
        item.month,
        'Canonical recurrence month',
      );
      const dayOfMonth = positiveSafeInteger(
        item.dayOfMonth,
        'Canonical recurrence dayOfMonth',
      );
      if (month > 12) {
        throw new Error('Canonical recurrence month must be between 1 and 12.');
      }
      if (dayOfMonth > 31) {
        throw new Error('Canonical recurrence dayOfMonth must be between 1 and 31.');
      }
      return { frequency: 'yearly', interval, month, dayOfMonth, end };
    }
    default:
      throw new Error(`Unknown canonical recurrence frequency: ${frequency}`);
  }
}

function decodeRecurrenceException(
  value: unknown,
): CanonicalRecurrenceException {
  const item = objectValue(value, 'Canonical recurrence exception');
  const state = stringValue(
    item.state,
    'Canonical recurrence exception state',
  );
  const occurrence = decodeOccurrence(
    item.occurrence,
    'Canonical recurrence occurrence',
  );

  switch (state) {
    case 'cancelled':
      exactKeys(
        item,
        ['occurrence', 'state'],
        'Canonical cancelled recurrence exception',
      );
      return { occurrence, state: 'cancelled' };
    case 'rescheduled': {
      exactKeys(
        item,
        ['occurrence', 'state', 'startDate', 'deadline'],
        'Canonical rescheduled recurrence exception',
      );
      const startDate = dateValue(
        item.startDate,
        'Canonical recurrence exception startDate',
      );
      const deadline = dateValue(
        item.deadline,
        'Canonical recurrence exception deadline',
      );
      if (Date.parse(deadline) < Date.parse(startDate)) {
        throw new Error('Canonical recurrence exception deadline precedes its start.');
      }
      return {
        occurrence,
        state: 'rescheduled',
        startDate,
        deadline,
      };
    }
    case 'detached':
      exactKeys(
        item,
        ['occurrence', 'state', 'detachedRecordId'],
        'Canonical detached recurrence exception',
      );
      return {
        occurrence,
        state: 'detached',
        detachedRecordId: recordIdValue(
          item.detachedRecordId,
          'Canonical detached recurrence record id',
        ),
      };
    default:
      throw new Error(`Unknown canonical recurrence exception state: ${state}`);
  }
}

function decodeRecurrence(
  value: unknown,
  ownerKind: 'task' | 'event',
  ownerRecordId: OpaqueRecordId,
): CanonicalRecurrenceSeries | null {
  if (value === null) {
    return null;
  }
  const item = objectValue(value, 'Canonical recurrence series');
  exactKeys(
    item,
    ['seriesId', 'ownerKind', 'ownerRecordId', 'rule', 'exceptions'],
    'Canonical recurrence series',
  );
  if (item.ownerKind !== ownerKind) {
    throw new Error(
      `Canonical recurrence owner kind must be ${ownerKind}.`,
    );
  }
  const checkedOwnerId = recordIdValue(
    item.ownerRecordId,
    'Canonical recurrence ownerRecordId',
  );
  if (checkedOwnerId !== ownerRecordId) {
    throw new Error('Canonical recurrence ownerRecordId does not match its record.');
  }
  if (!Array.isArray(item.exceptions)) {
    throw new Error('Canonical recurrence exceptions must be an array.');
  }
  return defineCanonicalRecurrenceSeries({
    seriesId: parseOpaqueRecurrenceSeriesId(
      stringValue(item.seriesId, 'Canonical recurrence seriesId'),
    ),
    ownerKind,
    ownerRecordId,
    rule: decodeRecurrenceRule(item.rule),
    exceptions: item.exceptions.map(decodeRecurrenceException),
  });
}

function decodeArtifactBindings(
  value: unknown,
  projectId: OpaqueRecordId,
): readonly ProjectArtifactBinding[] {
  if (!Array.isArray(value)) {
    throw new Error('Canonical project artifactBindings must be an array.');
  }
  const bindings = value.map((rawBinding) => {
    const binding = objectValue(
      rawBinding,
      'Canonical project artifact binding',
    );
    exactKeys(
      binding,
      ['role', 'artifactId'],
      'Canonical project artifact binding',
    );
    const role = stringValue(
      binding.role,
      'Canonical project artifact role',
    );
    if (!ARTIFACT_ROLES.has(role as ProjectArtifactRole)) {
      throw new Error(`Unknown canonical project artifact role: ${role}`);
    }
    return {
      role: role as ProjectArtifactRole,
      artifactId: parseOpaqueExternalArtifactId(
        stringValue(
          binding.artifactId,
          'Canonical project artifact id',
        ),
      ),
    };
  });

  return defineProjectArtifactAssociations({
    projectId,
    bindings,
  }).bindings;
}

function decodeSchemaDefinition(
  value: unknown,
): CanonicalPropertyDefinition {
  const item = objectValue(value, 'Canonical schema definition');
  const type = stringValue(item.type, 'Canonical schema definition type');

  switch (type) {
    case 'text':
    case 'number':
    case 'date':
    case 'checkbox':
      exactKeys(item, ['type'], `Canonical ${type} schema definition`);
      return { type };
    case 'select':
    case 'multi-select': {
      exactKeys(
        item,
        ['type', 'options'],
        `Canonical ${type} schema definition`,
      );
      if (!Array.isArray(item.options)) {
        throw new Error(`Canonical ${type} schema options must be an array.`);
      }
      const options: CanonicalSelectOption[] = item.options.map((rawOption) => {
        const option = objectValue(
          rawOption,
          `Canonical ${type} schema option`,
        );
        exactKeys(
          option,
          ['id', 'label'],
          `Canonical ${type} schema option`,
        );
        return {
          id: parseOpaqueSchemaOptionId(
            stringValue(option.id, `Canonical ${type} schema option id`),
          ),
          label: stringValue(
            option.label,
            `Canonical ${type} schema option label`,
          ),
        };
      });
      return { type, options };
    }
    case 'relation': {
      exactKeys(
        item,
        ['type', 'targetKinds'],
        'Canonical relation schema definition',
      );
      if (!Array.isArray(item.targetKinds) || item.targetKinds.length === 0) {
        throw new Error('Canonical relation schema targetKinds must be a non-empty array.');
      }
      const targetKinds = item.targetKinds.map((rawKind) => {
        const kind = stringValue(rawKind, 'Canonical relation target kind');
        if (!RELATABLE_KINDS.has(kind as CanonicalRelatableRecordKind)) {
          throw new Error(`Unknown canonical relation target kind: ${kind}`);
        }
        return kind as CanonicalRelatableRecordKind;
      });
      if (new Set(targetKinds).size !== targetKinds.length) {
        throw new Error('Canonical relation schema contains a duplicate target kind.');
      }
      return { type: 'relation', targetKinds };
    }
    case 'rollup': {
      exactKeys(
        item,
        ['type', 'relationSchemaId', 'targetSchemaId', 'aggregation'],
        'Canonical rollup schema definition',
      );
      const aggregation = stringValue(
        item.aggregation,
        'Canonical rollup aggregation',
      );
      if (!ROLLUP_AGGREGATIONS.has(aggregation as CanonicalRollupAggregation)) {
        throw new Error(`Unknown canonical rollup aggregation: ${aggregation}`);
      }
      return {
        type: 'rollup',
        relationSchemaId: recordIdValue(
          item.relationSchemaId,
          'Canonical rollup relationSchemaId',
        ),
        targetSchemaId: recordIdValue(
          item.targetSchemaId,
          'Canonical rollup targetSchemaId',
        ),
        aggregation: aggregation as CanonicalRollupAggregation,
      };
    }
    case 'formula':
      exactKeys(
        item,
        ['type', 'expression'],
        'Canonical formula schema definition',
      );
      return {
        type: 'formula',
        expression: stringValue(
          item.expression,
          'Canonical formula expression',
        ),
      };
    default:
      throw new Error(`Unknown canonical schema definition type: ${type}`);
  }
}

function decodeTask(
  value: Record<string, unknown>,
): CanonicalTaskRecordV2 {
  exactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'id',
      'name',
      'description',
      'projectId',
      'executionState',
      'workflowStageId',
      'executionOrder',
      'workflowOrder',
      'weight',
      'isFixedDuration',
      'fixedDuration',
      'maxDuration',
      'isCompleted',
      'createdAt',
      'startDate',
      'deadline',
      'properties',
      'recurrence',
    ],
    'Canonical task record',
  );
  const header = headerValue(value, 'task');
  const projectId = optionalRecordIdValue(
    value.projectId,
    'Canonical task projectId',
  );
  const executionState = stringValue(
    value.executionState,
    'Canonical task executionState',
  );
  if (!EXECUTION_STATES.has(executionState as CanonicalExecutionState)) {
    throw new Error(`Unknown canonical execution state: ${executionState}`);
  }
  const workflowStageId = optionalRecordIdValue(
    value.workflowStageId,
    'Canonical task workflowStageId',
  );
  if (typeof value.executionOrder !== 'number') {
    throw new Error('Canonical task executionOrder must be a number.');
  }
  const executionOrder = canonicalOrderPosition(value.executionOrder);
  let workflowOrder = null;
  if (value.workflowOrder !== null) {
    if (typeof value.workflowOrder !== 'number') {
      throw new Error('Canonical task workflowOrder must be a number or null.');
    }
    workflowOrder = canonicalOrderPosition(value.workflowOrder);
  }
  if (workflowStageId === null && workflowOrder !== null) {
    throw new Error('Canonical task without workflowStageId cannot have workflowOrder.');
  }
  if (workflowStageId !== null) {
    if (projectId === null) {
      throw new Error('Canonical task with workflowStageId must belong to a project.');
    }
    if (workflowOrder === null) {
      throw new Error('Canonical task with workflowStageId must have workflowOrder.');
    }
  }
  const createdAt = dateValue(
    value.createdAt,
    'Canonical task createdAt',
  );
  const startDate = optionalDateValue(
    value.startDate,
    'Canonical task startDate',
  );
  const deadline = optionalDateValue(
    value.deadline,
    'Canonical task deadline',
  );
  if (
    startDate !== null
    && deadline !== null
    && Date.parse(deadline) < Date.parse(startDate)
  ) {
    throw new Error('Canonical task deadline precedes its startDate.');
  }

  return {
    ...header,
    description: stringValue(
      value.description,
      'Canonical task description',
    ),
    projectId,
    executionState: executionState as CanonicalExecutionState,
    workflowStageId,
    executionOrder,
    workflowOrder,
    weight: positiveNumber(value.weight, 'Canonical task weight'),
    isFixedDuration: booleanValue(
      value.isFixedDuration,
      'Canonical task isFixedDuration',
    ),
    fixedDuration: optionalPositiveNumber(
      value.fixedDuration,
      'Canonical task fixedDuration',
    ),
    maxDuration: optionalPositiveNumber(
      value.maxDuration,
      'Canonical task maxDuration',
    ),
    isCompleted: booleanValue(
      value.isCompleted,
      'Canonical task isCompleted',
    ),
    createdAt,
    startDate,
    deadline,
    properties: decodePropertyValues(value.properties),
    recurrence: decodeRecurrence(
      value.recurrence,
      'task',
      header.id,
    ),
  };
}

function decodeProject(
  value: Record<string, unknown>,
): CanonicalProjectRecordV2 {
  exactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'id',
      'name',
      'description',
      'createdAt',
      'status',
      'archivedAt',
      'artifactBindings',
    ],
    'Canonical project record',
  );
  const header = headerValue(value, 'project');
  const status = stringValue(
    value.status,
    'Canonical project status',
  );
  if (!PROJECT_STATES.has(status as CanonicalProjectLifecycleState)) {
    throw new Error(`Unknown canonical project status: ${status}`);
  }
  return {
    ...header,
    description: stringValue(
      value.description,
      'Canonical project description',
    ),
    createdAt: dateValue(
      value.createdAt,
      'Canonical project createdAt',
    ),
    status: status as CanonicalProjectLifecycleState,
    archivedAt: optionalDateValue(
      value.archivedAt,
      'Canonical project archivedAt',
    ),
    artifactBindings: decodeArtifactBindings(
      value.artifactBindings,
      header.id,
    ),
  };
}

function decodeEvent(
  value: Record<string, unknown>,
): CanonicalEventRecordV2 {
  exactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'id',
      'name',
      'description',
      'projectId',
      'createdAt',
      'startDate',
      'deadline',
      'isCompleted',
      'properties',
      'recurrence',
    ],
    'Canonical event record',
  );
  const header = headerValue(value, 'event');
  const startDate = dateValue(
    value.startDate,
    'Canonical event startDate',
  );
  const deadline = dateValue(
    value.deadline,
    'Canonical event deadline',
  );
  if (Date.parse(deadline) < Date.parse(startDate)) {
    throw new Error('Canonical event deadline precedes its startDate.');
  }
  return {
    ...header,
    description: stringValue(
      value.description,
      'Canonical event description',
    ),
    projectId: optionalRecordIdValue(
      value.projectId,
      'Canonical event projectId',
    ),
    createdAt: dateValue(
      value.createdAt,
      'Canonical event createdAt',
    ),
    startDate,
    deadline,
    isCompleted: booleanValue(
      value.isCompleted,
      'Canonical event isCompleted',
    ),
    properties: decodePropertyValues(value.properties),
    recurrence: decodeRecurrence(
      value.recurrence,
      'event',
      header.id,
    ),
  };
}

function decodeSchema(
  value: Record<string, unknown>,
): CanonicalPropertySchemaRecord {
  exactKeys(
    value,
    ['schemaVersion', 'kind', 'id', 'name', 'definition'],
    'Canonical schema record',
  );
  return defineCanonicalPropertySchema({
    header: headerValue(value, 'schema'),
    definition: decodeSchemaDefinition(value.definition),
  });
}

function decodeWorkflowStage(
  value: Record<string, unknown>,
): CanonicalWorkflowStageStateRecord {
  exactKeys(
    value,
    ['schemaVersion', 'kind', 'id', 'name', 'projectId'],
    'Canonical workflow-stage record',
  );
  return {
    ...headerValue(value, 'workflow-stage'),
    projectId: recordIdValue(
      value.projectId,
      'Canonical workflow-stage projectId',
    ),
  };
}

export function decodeCanonicalRecordV2(
  value: unknown,
): CanonicalRecordV2 {
  const record = objectValue(value, 'Canonical record');
  if (record.schemaVersion !== CANONICAL_RECORD_SCHEMA_VERSION) {
    throw new Error('Canonical record schemaVersion is unsupported.');
  }
  const kind = stringValue(record.kind, 'Canonical record kind');
  if (!RECORD_KINDS.has(kind as CanonicalRecordKind)) {
    throw new Error(`Unknown canonical record kind: ${kind}`);
  }

  switch (kind) {
    case 'task':
      return decodeTask(record);
    case 'project':
      return decodeProject(record);
    case 'event':
      return decodeEvent(record);
    case 'schema':
      return decodeSchema(record);
    case 'workflow-stage':
      return decodeWorkflowStage(record);
    default:
      throw new Error(`Unknown canonical record kind: ${kind}`);
  }
}

export function encodeCanonicalRecordV2(
  record: CanonicalRecordV2,
): CanonicalRecordV2 {
  return decodeCanonicalRecordV2(record);
}
