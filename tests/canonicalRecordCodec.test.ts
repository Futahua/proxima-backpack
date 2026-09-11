import { describe, expect, it } from 'vitest';

import {
  canonicalRecordV2Codec,
  createCanonicalJsonRecordStore,
} from '../src/app/canonicalRecordCodec.js';
import { RecordStoreFormatError } from '../src/app/jsonRecordStore.js';
import {
  opaqueExternalArtifactIdFromRandomBytes,
} from '../src/domain/canonicalArtifactAssociation.js';
import {
  CANONICAL_RECORD_SCHEMA_VERSION,
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  canonicalOrderPosition,
} from '../src/domain/canonicalOrdering.js';
import {
  defineCanonicalRecurrenceSeries,
  opaqueRecurrenceSeriesIdFromRandomBytes,
} from '../src/domain/canonicalRecurrence.js';
import {
  defineCanonicalRelationValue,
} from '../src/domain/canonicalRelation.js';
import {
  defineCanonicalPropertySchema,
  opaqueSchemaOptionIdFromRandomBytes,
  type CanonicalPropertyDefinition,
  type CanonicalPropertySchemaRecord,
} from '../src/domain/canonicalSchema.js';
import type {
  CanonicalEventRecordV2,
  CanonicalProjectRecordV2,
  CanonicalTaskRecordV2,
  CanonicalRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type {
  CanonicalWorkflowStageStateRecord,
} from '../src/domain/canonicalTaskState.js';
import type {
  RecordStoreFileBackend,
  RecordStoreFileMutationResult,
  RecordStoreFileName,
} from '../src/ports/recordStore.js';

function bytes(value: number): Uint8Array {
  const result = new Uint8Array(16);
  result[15] = value;
  return result;
}

function recordId(value: number): OpaqueRecordId {
  return opaqueRecordIdFromRandomBytes(bytes(value));
}

function optionId(value: number) {
  return opaqueSchemaOptionIdFromRandomBytes(bytes(value));
}

function artifactId(value: number) {
  return opaqueExternalArtifactIdFromRandomBytes(bytes(value));
}

function seriesId(value: number) {
  return opaqueRecurrenceSeriesIdFromRandomBytes(bytes(value));
}

function taskRecord(): CanonicalTaskRecordV2 {
  const id = recordId(1);
  const projectId = recordId(2);
  const workflowStageId = recordId(3);
  const textSchemaId = recordId(10);
  const numberSchemaId = recordId(11);
  const dateSchemaId = recordId(12);
  const checkboxSchemaId = recordId(13);
  const selectSchemaId = recordId(14);
  const multiSelectSchemaId = recordId(15);
  const relationSchemaId = recordId(16);

  return {
    ...defineCanonicalRecordHeader({
      kind: 'task',
      id,
      name: 'Task: / [] ? *',
    }),
    description: 'Canonical task description',
    projectId,
    executionState: 'running',
    workflowStageId,
    executionOrder: canonicalOrderPosition(4),
    workflowOrder: canonicalOrderPosition(7),
    weight: 1.5,
    isFixedDuration: true,
    fixedDuration: 45,
    maxDuration: 180,
    isCompleted: false,
    createdAt: '2026-09-11T01:00:00.000Z',
    startDate: '2026-09-11T02:00:00.000Z',
    deadline: '2026-09-11T04:00:00.000Z',
    properties: {
      [textSchemaId]: {
        type: 'text',
        value: 'literal [[not a relation]]',
      },
      [numberSchemaId]: {
        type: 'number',
        value: 42.5,
      },
      [dateSchemaId]: {
        type: 'date',
        value: '2026-09-12',
      },
      [checkboxSchemaId]: {
        type: 'checkbox',
        value: true,
      },
      [selectSchemaId]: {
        type: 'select',
        optionId: optionId(1),
      },
      [multiSelectSchemaId]: {
        type: 'multi-select',
        optionIds: [optionId(2), optionId(3)],
      },
      [relationSchemaId]: {
        type: 'relation',
        value: defineCanonicalRelationValue({
          relationSchemaId,
          targetRecordIds: [recordId(50), recordId(51)],
        }),
      },
    },
    recurrence: defineCanonicalRecurrenceSeries({
      seriesId: seriesId(1),
      ownerKind: 'task',
      ownerRecordId: id,
      rule: {
        frequency: 'weekly',
        interval: 2,
        weekdays: ['mon', 'thu'],
        end: {
          kind: 'count',
          count: 5,
        },
      },
      exceptions: [
        {
          occurrence: {
            seriesId: seriesId(1),
            scheduledStart: '2026-09-17T02:00:00.000Z',
          },
          state: 'rescheduled',
          startDate: '2026-09-17T03:00:00.000Z',
          deadline: '2026-09-17T05:00:00.000Z',
        },
      ],
    }),
  };
}

function projectRecord(): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'project',
      id: recordId(20),
      name: 'Combined project',
    }),
    description: 'Tasks and events may coexist here.',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [
      {
        role: 'notes-root',
        artifactId: artifactId(1),
      },
      {
        role: 'drawings-root',
        artifactId: artifactId(2),
      },
    ],
  };
}

function eventRecord(): CanonicalEventRecordV2 {
  const id = recordId(30);
  return {
    ...defineCanonicalRecordHeader({
      kind: 'event',
      id,
      name: 'Review',
    }),
    description: 'Canonical event',
    projectId: recordId(20),
    createdAt: '2026-09-01T00:00:00.000Z',
    startDate: '2026-09-11T09:00:00.000Z',
    deadline: '2026-09-11T10:00:00.000Z',
    isCompleted: false,
    properties: {},
    recurrence: defineCanonicalRecurrenceSeries({
      seriesId: seriesId(2),
      ownerKind: 'event',
      ownerRecordId: id,
      rule: {
        frequency: 'daily',
        interval: 1,
        end: { kind: 'never' },
      },
      exceptions: [],
    }),
  };
}

function workflowStageRecord(): CanonicalWorkflowStageStateRecord {
  return {
    ...defineCanonicalRecordHeader({
      kind: 'workflow-stage',
      id: recordId(40),
      name: 'Review',
    }),
    projectId: recordId(20),
  };
}

function schemaRecord(
  value: number,
  definition: CanonicalPropertyDefinition,
): CanonicalPropertySchemaRecord {
  return defineCanonicalPropertySchema({
    header: defineCanonicalRecordHeader({
      kind: 'schema',
      id: recordId(value),
      name: `Schema ${value}`,
    }),
    definition,
  });
}

class MemoryRecordFileBackend implements RecordStoreFileBackend {
  private readonly files = new Map<
    string,
    { text: string; revision: string }
  >();
  private nextRevision = 1;

  async listRecordFiles(): Promise<readonly string[]> {
    return [...this.files.keys()].sort();
  }

  async readRecordFile(
    fileName: RecordStoreFileName,
  ) {
    const file = this.files.get(fileName);
    return file
      ? { ...file }
      : undefined;
  }

  async createRecordFile(
    fileName: RecordStoreFileName,
    text: string,
  ): Promise<RecordStoreFileMutationResult> {
    if (this.files.has(fileName)) {
      return { ok: false, reason: 'already-exists' };
    }
    const revision = this.revision();
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }

  async writeRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    text: string,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    const current = this.files.get(fileName);
    if (!current) {
      return { ok: false, reason: 'missing' };
    }
    if (current.revision !== expectedRevision) {
      return {
        ok: false,
        reason: 'stale',
        actualRevision: current.revision,
      };
    }
    const revision = this.revision();
    this.files.set(fileName, { text, revision });
    return { ok: true, revision };
  }

  async deleteRecordFileIfUnchanged(
    fileName: RecordStoreFileName,
    expectedRevision: string,
  ): Promise<RecordStoreFileMutationResult> {
    const current = this.files.get(fileName);
    if (!current) {
      return { ok: false, reason: 'missing' };
    }
    if (current.revision !== expectedRevision) {
      return {
        ok: false,
        reason: 'stale',
        actualRevision: current.revision,
      };
    }
    this.files.delete(fileName);
    return { ok: true, revision: this.revision() };
  }

  seed(
    fileName: string,
    text: string,
  ): void {
    this.files.set(fileName, {
      text,
      revision: this.revision(),
    });
  }

  text(fileName: string): string | undefined {
    return this.files.get(fileName)?.text;
  }

  private revision(): string {
    return `memory-revision-${this.nextRevision++}`;
  }
}

describe('Stage 7 slice 2 canonical-domain-v2 record codec', () => {
  it('round-trips the complete canonical task shape and every stored property value family', () => {
    const task = taskRecord();

    expect(
      canonicalRecordV2Codec.decode(
        canonicalRecordV2Codec.encode(task),
      ),
    ).toEqual(task);
  });

  it('round-trips project lifecycle data and opaque external-artifact bindings without locators', () => {
    const project = projectRecord();
    const decoded = canonicalRecordV2Codec.decode(project);

    expect(decoded).toEqual(project);
    if (decoded.kind !== 'project') {
      throw new Error('project fixture changed kind');
    }
    expect(decoded.artifactBindings).toEqual(project.artifactBindings);
    expect(decoded).not.toHaveProperty('linkedFolders');
    expect(decoded).not.toHaveProperty('projectType');
    expect(decoded.artifactBindings[0]).not.toHaveProperty('path');
  });

  it('round-trips event project membership, chronology, property data and recurrence', () => {
    const event = eventRecord();

    expect(
      canonicalRecordV2Codec.decode(event),
    ).toEqual(event);
  });

  it('round-trips workflow-stage definition by opaque project identity', () => {
    const stage = workflowStageRecord();

    expect(
      canonicalRecordV2Codec.decode(stage),
    ).toEqual(stage);
  });

  it('validates every canonical schema-definition family including stable option ids', () => {
    const definitions: CanonicalPropertyDefinition[] = [
      { type: 'text' },
      { type: 'number' },
      { type: 'date' },
      { type: 'checkbox' },
      {
        type: 'select',
        options: [{ id: optionId(10), label: 'One' }],
      },
      {
        type: 'multi-select',
        options: [
          { id: optionId(11), label: 'A' },
          { id: optionId(12), label: 'B' },
        ],
      },
      {
        type: 'relation',
        targetKinds: ['task', 'project', 'event'],
      },
      {
        type: 'rollup',
        relationSchemaId: recordId(70),
        targetSchemaId: recordId(71),
        aggregation: 'sum',
      },
      {
        type: 'formula',
        expression: 'priority * weight',
      },
    ];

    expect(
      definitions.map((definition, index) =>
        canonicalRecordV2Codec.decode(
          schemaRecord(80 + index, definition),
        )),
    ).toHaveLength(definitions.length);
  });

  it('binds the canonical codec to the JSON RecordStore boundary for normal create/read', async () => {
    const backend = new MemoryRecordFileBackend();
    const records = createCanonicalJsonRecordStore(backend);
    const task = taskRecord();

    const created = await records.createIfAbsent(task);
    expect(created.ok).toBe(true);
    const observed = await records.read(task.id);
    expect(observed?.record).toEqual(task);
    expect(observed?.kind).toBe('task');

    const raw = backend.text(`${task.id}.json`);
    expect(raw).toBeDefined();
    const document = JSON.parse(raw as string) as {
      formatVersion: number;
      record: CanonicalRecordV2;
    };
    expect(document.formatVersion).toBe(1);
    expect(document.record.schemaVersion).toBe(
      CANONICAL_RECORD_SCHEMA_VERSION,
    );
    expect(document.record).not.toHaveProperty('source');
    expect(document.record).not.toHaveProperty('orderIndex');
    expect(document.record).not.toHaveProperty('projectType');
  });

  it('surfaces canonical codec rejection from a raw record file as schema-invalid', async () => {
    const backend = new MemoryRecordFileBackend();
    const task = taskRecord();
    const malformed = {
      ...task,
      orderIndex: 9,
    };
    backend.seed(
      `${task.id}.json`,
      `${JSON.stringify({
        formatVersion: 1,
        record: malformed,
      })}\n`,
    );

    await expect(
      createCanonicalJsonRecordStore(backend).read(task.id),
    ).rejects.toMatchObject({
      name: 'RecordStoreFormatError',
      code: 'schema-invalid',
    } satisfies Partial<RecordStoreFormatError>);
  });

  it('rejects legacy or local-state fields instead of silently preserving a second schema', () => {
    const task = taskRecord();
    const project = projectRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      orderIndex: 10,
    })).toThrow(/unexpected fields/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      source: { path: 'Tasks/legacy.md' },
    })).toThrow(/unexpected fields/);
    expect(() => canonicalRecordV2Codec.decode({
      ...project,
      projectType: 'task',
    })).toThrow(/unexpected fields/);
    expect(() => canonicalRecordV2Codec.decode({
      ...project,
      tabBgColor: '#fff',
    })).toThrow(/unexpected fields/);
  });

  it('rejects unknown schema versions and record kinds', () => {
    const task = taskRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      schemaVersion: 999,
    })).toThrow(/schemaVersion/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      kind: 'note',
    })).toThrow(/record kind/);
  });

  it('rejects impossible workflow ordering combinations', () => {
    const task = taskRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      workflowStageId: null,
      workflowOrder: 1,
    })).toThrow(/without workflowStageId/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      projectId: null,
    })).toThrow(/must belong to a project/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      workflowOrder: null,
    })).toThrow(/must have workflowOrder/);
  });

  it('rejects unsafe task numerics and inverted task chronology', () => {
    const task = taskRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      weight: 0,
    })).toThrow(/positive finite number/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      fixedDuration: -1,
    })).toThrow(/positive finite number/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      startDate: '2026-09-12T00:00:00.000Z',
      deadline: '2026-09-11T00:00:00.000Z',
    })).toThrow(/precedes/);
  });

  it('rejects non-opaque property schema ids, duplicate multi-select ids and non-opaque relation targets', () => {
    const task = taskRecord();
    const firstProperty = Object.values(task.properties)[0];
    if (!firstProperty) {
      throw new Error('task property fixture is empty');
    }

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      properties: {
        humanName: firstProperty,
      },
    })).toThrow(/Invalid opaque Proxima record id/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      properties: {
        [recordId(90)]: {
          type: 'multi-select',
          optionIds: [optionId(1), optionId(1)],
        },
      },
    })).toThrow(/duplicate option/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      properties: {
        [recordId(91)]: {
          type: 'relation',
          value: {
            relationSchemaId: recordId(91),
            targetRecordIds: ['[[Tasks/Human Name]]'],
          },
        },
      },
    })).toThrow(/Invalid opaque Proxima record id/);
  });

  it('rejects relation values whose schema identity disagrees with the property key', () => {
    const task = taskRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      properties: {
        [recordId(92)]: {
          type: 'relation',
          value: {
            relationSchemaId: recordId(93),
            targetRecordIds: [recordId(94)],
          },
        },
      },
    })).toThrow(/does not match relationSchemaId/);
  });

  it('rejects malformed nested schema definitions rather than accepting TypeScript-shaped assertions', () => {
    const relation = schemaRecord(100, {
      type: 'relation',
      targetKinds: ['task'],
    });
    const select = schemaRecord(101, {
      type: 'select',
      options: [{ id: optionId(20), label: 'One' }],
    });

    expect(() => canonicalRecordV2Codec.decode({
      ...relation,
      definition: {
        type: 'relation',
        targetKinds: ['task', 'folder'],
      },
    })).toThrow(/target kind/);
    expect(() => canonicalRecordV2Codec.decode({
      ...select,
      definition: {
        type: 'select',
        options: [
          { id: optionId(20), label: 'One' },
          { id: optionId(20), label: 'Duplicate id' },
        ],
      },
    })).toThrow(/Duplicate canonical schema-option id/);
    expect(() => canonicalRecordV2Codec.decode({
      ...relation,
      definition: {
        type: 'relation',
        targetKinds: ['task'],
        targetFolder: 'Tasks',
      },
    })).toThrow(/unexpected fields/);
  });

  it('rejects recurrence that is not owned by the enclosing task or event', () => {
    const task = taskRecord();
    if (!task.recurrence) {
      throw new Error('task recurrence fixture missing');
    }

    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      recurrence: {
        ...task.recurrence,
        ownerRecordId: recordId(120),
      },
    })).toThrow(/does not match its record/);
    expect(() => canonicalRecordV2Codec.decode({
      ...task,
      recurrence: {
        ...task.recurrence,
        ownerKind: 'event',
      },
    })).toThrow(/owner kind/);
  });

  it('rejects filesystem locator data inside canonical project artifact bindings', () => {
    const project = projectRecord();

    expect(() => canonicalRecordV2Codec.decode({
      ...project,
      artifactBindings: [
        {
          role: 'notes-root',
          artifactId: artifactId(1),
          path: 'D:/Creator Vault/Notes',
        },
      ],
    })).toThrow(/unexpected fields/);
    expect(() => canonicalRecordV2Codec.decode({
      ...project,
      artifactBindings: [
        {
          role: 'notes-root',
          artifactId: 'D:/Creator Vault/Notes',
        },
      ],
    })).toThrow(/Invalid opaque Proxima external-artifact id/);
  });
});
