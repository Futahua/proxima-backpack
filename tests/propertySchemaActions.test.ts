/**
 * The property-schema semantic actions: the boundary the three schema rows of the contract matrix were
 * missing.
 *
 * The record layer already wrote schemas and refused correctly; what it never had was an entry that accepts
 * `unknown`, answers a malformed submission with a sentence, mints one request id and leaves one terminal
 * event behind. These cases drive that entry over the real store and the real recovery coordinator, and each
 * one is written so it can fail: the malformed battery compares every record file's revision before and
 * after, the refusals assert the record layer's own vocabulary passing through unchanged, and the last case
 * asks the Backlog what it draws from what the wire wrote rather than trusting the write alone.
 */
import { describe, expect, it } from 'vitest';
import { projectBacklog } from '../src/app/backlogView.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  createPropertySchema,
  deletePropertySchema,
  updatePropertySchema,
  updateSchemaField,
  updateSchemaOption,
  type PropertySchemaMutationDependencies,
} from '../src/app/propertySchemaMutations.js';
import {
  PROPERTY_SCHEMA_ACTION_TYPES,
  parsePropertySchemaSubmission,
  submitPropertySchemaAction,
  type PropertySchemaActionDependencies,
  type PropertySchemaActionOutcome,
  type PropertySchemaWriteOperations,
} from '../src/app/propertySchemaActions.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { EMPTY_PROJECT_BACKLOG_VIEW } from '../src/browser/projectBacklog.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { opaqueSchemaOptionIdFromRandomBytes, type OpaqueSchemaOptionId } from '../src/domain/canonicalSchema.js';
import type { RecordStoreFileName } from '../src/ports/recordStore.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds, type RecordingAudit } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T08:30:00+07:00';

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function optionIdFromLastByte(value: number): OpaqueSchemaOptionId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueSchemaOptionIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
/** A canonical-shaped id that no record carries, for the not-found case. */
const ABSENT = idFromLastByte(99);

interface World {
  readonly files: MemoryRecordFiles;
  readonly taskDeps: TaskMutationDependencies;
  readonly agent: PropertySchemaActionDependencies;
  readonly audit: RecordingAudit;
  revisionOf(schemaId: string): Promise<string | undefined>;
  fileNames(): Promise<readonly string[]>;
  revisionMap(): Promise<Record<string, string>>;
  create(name: string, definition: unknown): Promise<PropertySchemaActionOutcome>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  await recovery.load();
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: { next: (prefix = 'id') => `${prefix}-request` },
  });

  let nextId = 40;
  let nextOption = 300;
  const readonly = { store, coordinator, clock: fixedClock(CLOCK_ISO) };
  const taskDeps: TaskMutationDependencies = { ...readonly, allocateRecordId: () => idFromLastByte(nextId++) };
  const mutations: PropertySchemaMutationDependencies = {
    ...readonly,
    allocateRecordId: () => idFromLastByte(nextId++),
    allocateOptionId: () => optionIdFromLastByte(nextOption++),
  };

  const project: CanonicalProjectRecordV2 = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
  expect((await store.createIfAbsent(project as CanonicalRecordV2)).ok).toBe(true);

  const operations: PropertySchemaWriteOperations = {
    createPropertySchema: (request) => createPropertySchema(mutations, request),
    updatePropertySchema: (input) => updatePropertySchema(mutations, input),
    updateSchemaField: (input) => updateSchemaField(mutations, input),
    updateSchemaOption: (input) => updateSchemaOption(mutations, input),
    deletePropertySchema: (input) => deletePropertySchema(mutations, input),
  };

  const audit = recordingAudit();
  const agent: PropertySchemaActionDependencies = {
    writes: async () => operations,
    unavailableReason: () => null,
    ids: semanticIds(),
    audit,
  };

  return {
    files,
    taskDeps,
    agent,
    audit,
    revisionOf: async (schemaId) => (await store.read(schemaId as OpaqueRecordId))?.observedRevision,
    fileNames: async () => await files.listRecordFiles(),
    revisionMap: async () => {
      const map: Record<string, string> = {};
      for (const fileName of await files.listRecordFiles()) {
        map[fileName] = (await files.readRecordFile(fileName as RecordStoreFileName))!.revision;
      }
      return map;
    },
    create: async (name, definition) => await submitPropertySchemaAction(agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.create,
      name,
      definition,
    }),
  };
}

function accepted(outcome: PropertySchemaActionOutcome): Extract<PropertySchemaActionOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

describe('property-schema semantic actions', () => {
  it('accepts all five verbs through the boundary, with one event per run', async () => {
    const w = await world();
    // A select carries options, so the option verb has a property to change.
    const created = accepted(await w.create('Story points', { type: 'select', options: [] }));
    expect(created).toMatchObject({ verb: 'create', actionType: 'property.schema.create', outcome: 'created' });
    expect(created.requestId).toMatch(/^semantic-request/);
    expect(created.entityIds).toEqual([created.recordId]);
    expect(created.revision).toBe(await w.revisionOf(created.recordId));

    const renamed = accepted(await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.update,
      schemaId: created.recordId,
      expectedRevision: created.revision,
      name: 'Effort',
    }));
    expect(renamed).toMatchObject({ verb: 'update', outcome: 'updated', entityIds: [created.recordId] });
    expect(renamed.revision).not.toBe(created.revision);

    const option = accepted(await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.option,
      schemaId: created.recordId,
      expectedRevision: renamed.revision,
      option: { kind: 'add', label: 'Small' },
    }));
    expect(option).toMatchObject({ verb: 'option', actionType: 'property.schema.option.change', outcome: 'option-added' });

    const field = accepted(await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.field,
      schemaId: created.recordId,
      expectedRevision: option.revision,
      definition: { type: 'select', options: [] },
    }));
    expect(field).toMatchObject({ verb: 'field', outcome: 'updated' });

    const removed = accepted(await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.delete,
      schemaId: created.recordId,
      expectedRevision: field.revision,
    }));
    expect(removed).toMatchObject({ verb: 'delete', outcome: 'deleted', entityIds: [created.recordId] });
    expect(await w.revisionOf(created.recordId)).toBeUndefined();

    // Five runs, five events, each naming the verb it was and carrying its own run's id.
    expect(w.audit.events.map((event) => event.actionType)).toEqual([
      'property.schema.create',
      'property.schema.update',
      'property.schema.option.change',
      'property.schema.field.change',
      'property.schema.delete',
    ]);
    expect(w.audit.events.every((event) => event.outcome === 'accepted')).toBe(true);
    expect(w.audit.events.every((event) => event.errorCode === undefined)).toBe(true);
    expect(new Set(w.audit.events.map((event) => event.requestId)).size).toBe(5);
    const ids = [created.requestId, renamed.requestId, option.requestId, field.requestId, removed.requestId];
    expect(w.audit.events.map((event) => event.requestId)).toEqual(ids);
  });

  it('refuses in the record layer vocabulary, and journals the refusal with its targets', async () => {
    const w = await world();
    const created = accepted(await w.create('Carries a value', { type: 'text' }));

    // A blank name is the layer's validation refusal, not a second copy of the rule here.
    const blank = await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.update,
      schemaId: created.recordId,
      expectedRevision: created.revision,
      name: '   ',
    });
    expect(blank).toMatchObject({ ok: false, reason: 'validation-refused', verb: 'update', entityIds: [created.recordId] });
    expect(w.audit.events.at(-1)).toMatchObject({ outcome: 'rejected', errorCode: 'validation-refused', entityIds: [created.recordId] });

    // An absent schema is the layer's not-found, and a stale revision names the revision that won.
    const absent = await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.delete,
      schemaId: ABSENT,
      expectedRevision: 'anything@1',
    });
    expect(absent).toMatchObject({ ok: false, reason: 'not-found', entityIds: [ABSENT] });

    const stale = await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.update,
      schemaId: created.recordId,
      expectedRevision: 'anything@1',
      name: 'Effort',
    });
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', actualRevision: created.revision });

    // A re-type with a stored value in use refuses with the count, which is an answer rather than a wall.
    const task = await createTask(w.taskDeps, {
      name: 'Carries a value',
      projectId: PROJECT,
      properties: { [created.recordId]: { type: 'text', value: 'three' } },
      executionOrder: 0,
    });
    expect(task.ok).toBe(true);

    const conflicted = await submitPropertySchemaAction(w.agent, {
      type: PROPERTY_SCHEMA_ACTION_TYPES.update,
      schemaId: created.recordId,
      expectedRevision: created.revision,
      definition: { type: 'number' },
    });
    expect(conflicted).toMatchObject({ ok: false, reason: 'semantic-conflict', affectedRecordCount: 1 });
    if (conflicted.ok) throw new Error('the re-type was accepted');
    expect(conflicted.detail).toContain('1 record(s)');
    expect(w.audit.events.at(-1)).toMatchObject({ outcome: 'rejected', errorCode: 'semantic-conflict' });
    expect(await w.revisionOf(created.recordId)).toBe(created.revision);
  });

  it('refuses a malformed or unsupported submission, correlates it, and writes nothing', async () => {
    const w = await world();
    const created = accepted(await w.create('Story points', { type: 'number' }));
    const beforeFiles = await w.fileNames();
    const beforeRevisions = await w.revisionMap();
    const eventsBefore = w.audit.events.length;

    const wellFormed = {
      type: PROPERTY_SCHEMA_ACTION_TYPES.update,
      schemaId: created.recordId,
      expectedRevision: created.revision,
      name: 'Effort',
    };

    const battery: readonly { readonly input: unknown; readonly reason: string; readonly actionType: string }[] = [
      { input: null, reason: 'malformed-submission', actionType: 'unknown' },
      { input: 42, reason: 'malformed-submission', actionType: 'unknown' },
      { input: [], reason: 'malformed-submission', actionType: 'unknown' },
      { input: {}, reason: 'malformed-submission', actionType: 'unknown' },
      { input: { ...wellFormed, type: '' }, reason: 'malformed-submission', actionType: 'unknown' },
      { input: { ...wellFormed, type: 'property.schema.rename' }, reason: 'unsupported-verb', actionType: 'property.schema.rename' },
      { input: { type: PROPERTY_SCHEMA_ACTION_TYPES.create, name: 'No definition' }, reason: 'malformed-submission', actionType: 'property.schema.create' },
      { input: { type: PROPERTY_SCHEMA_ACTION_TYPES.create, name: 'Bad definition', definition: { type: '' } }, reason: 'malformed-submission', actionType: 'property.schema.create' },
      { input: { ...wellFormed, schemaId: '' }, reason: 'malformed-submission', actionType: 'property.schema.update' },
      { input: { ...wellFormed, expectedRevision: '' }, reason: 'malformed-submission', actionType: 'property.schema.update' },
      { input: { type: PROPERTY_SCHEMA_ACTION_TYPES.update, schemaId: created.recordId, expectedRevision: created.revision }, reason: 'malformed-submission', actionType: 'property.schema.update' },
      { input: { ...wellFormed, name: 7 }, reason: 'malformed-submission', actionType: 'property.schema.update' },
      { input: { ...wellFormed, type: PROPERTY_SCHEMA_ACTION_TYPES.field, definition: 'text' }, reason: 'malformed-submission', actionType: 'property.schema.field.change' },
      { input: { ...wellFormed, type: PROPERTY_SCHEMA_ACTION_TYPES.option, option: { kind: 'add' } }, reason: 'malformed-submission', actionType: 'property.schema.option.change' },
      { input: { ...wellFormed, type: PROPERTY_SCHEMA_ACTION_TYPES.option, option: { kind: 'move', optionId: 'x' } }, reason: 'malformed-submission', actionType: 'property.schema.option.change' },
    ];

    const results: PropertySchemaActionOutcome[] = [];
    for (const entry of battery) {
      const result = await submitPropertySchemaAction(w.agent, entry.input);
      expect(result.ok, `${JSON.stringify(entry.input)} must be refused`).toBe(false);
      expect(result).toMatchObject({ reason: entry.reason, actionType: entry.actionType });
      expect(result.requestId).toMatch(/^semantic-request/);
      results.push(result);
    }

    // One rejected event per refusal, in order, each carrying its own result's id.
    const refusals = w.audit.events.slice(eventsBefore);
    expect(refusals).toHaveLength(battery.length);
    expect(refusals.map((event) => event.requestId)).toEqual(results.map((result) => result.requestId));
    expect(refusals.every((event) => event.outcome === 'rejected')).toBe(true);
    expect(refusals.filter((event) => event.errorCode === 'action-not-available').map((event) => event.actionType))
      .toEqual(['property.schema.rename']);
    expect(refusals[0]!.entityIds).toEqual([]);
    expect(refusals[6]!.entityIds).toEqual([]);

    // Nothing was written: the same files, at the same revisions.
    expect(await w.fileNames()).toEqual(beforeFiles);
    expect(await w.revisionMap()).toEqual(beforeRevisions);

    // The one submission in this case that *is* acceptable, so the id check means something rather than
    // riding on a refusal: the caller's `requestId` is ignored and the run carries the minted one.
    const smuggled = await submitPropertySchemaAction(w.agent, { ...wellFormed, requestId: 'caller-supplied' });
    expect(smuggled).toMatchObject({ ok: true, entityIds: [created.recordId] });
    expect(smuggled.requestId).not.toBe('caller-supplied');
    expect(w.audit.events.at(-1)!.requestId).toBe(smuggled.requestId);
    expect(w.audit.events.at(-1)).toMatchObject({ outcome: 'accepted', entityIds: [created.recordId] });
  });

  it('refuses by name when this run has no write path', async () => {
    const w = await world();
    const audit = recordingAudit();
    const outcome = await submitPropertySchemaAction(
      { writes: async () => null, unavailableReason: () => 'record-writes-need-an-activated-store', ids: semanticIds(), audit },
      { type: PROPERTY_SCHEMA_ACTION_TYPES.create, name: 'Story points', definition: { type: 'number' } },
    );

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'writes-unavailable',
      detail: 'record-writes-need-an-activated-store',
      verb: null,
      entityIds: [],
    });
    expect(audit.events).toEqual([{
      requestId: outcome.requestId,
      actionType: 'property.schema',
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'writes-unavailable',
    }]);
    expect(w.audit.events).toEqual([]);
  });

  it('writes a schema the Backlog draws, so the write is observable rather than only reported', async () => {
    const w = await world();
    const created = accepted(await w.create('Story points', { type: 'number' }));

    const task = await createTask(w.taskDeps, {
      name: 'Sized',
      projectId: PROJECT,
      properties: { [created.recordId]: { type: 'number', value: 3 } },
      executionOrder: 0,
    });
    if (!task.ok) throw new Error(`the task was refused: ${task.reason}`);

    const loaded = await recordStoreStateSource(createCanonicalJsonRecordStore(w.files)).load();
    const project = loaded.state.projects[0]!;
    const projection = projectBacklog(loaded.state, project, { ...EMPTY_PROJECT_BACKLOG_VIEW, projectId: project.id });

    // The column exists because a task carries a value for the property, and the cell is the stored value's
    // readable form - so this asserts the record the wire wrote, not the report the wire returned.
    const column = projection.columns.find((candidate) => candidate.propertyKey === created.recordId);
    expect(column).toBeDefined();
    const row = projection.rows.find((candidate) => candidate.taskId === task.recordId)!;
    expect(row.cells.find((cell) => cell.columnId === column!.id)?.text).toBe('3');
  });

  it('binds a parsed submission to the operation it names, so the wire cannot drift from the verb', async () => {
    const w = await world();
    const created = accepted(await w.create('Story points', { type: 'number' }));
    const operations: PropertySchemaWriteOperations = {
      createPropertySchema: async () => { throw new Error('not used'); },
      updatePropertySchema: async () => { throw new Error('not used'); },
      updateSchemaField: async () => { throw new Error('not used'); },
      updateSchemaOption: async () => { throw new Error('not used'); },
      deletePropertySchema: async () => { throw new Error('not used'); },
    };

    // Every accepted parse names its verb, and the verb's type is the one it was parsed from.
    for (const [verb, type] of Object.entries(PROPERTY_SCHEMA_ACTION_TYPES)) {
      const parsed = parsePropertySchemaSubmission(operations, type === PROPERTY_SCHEMA_ACTION_TYPES.create
        ? { type, name: 'Story points', definition: { type: 'number' } }
        : verb === 'update'
          ? { type, schemaId: created.recordId, expectedRevision: created.revision, name: 'Effort' }
          : verb === 'delete'
            ? { type, schemaId: created.recordId, expectedRevision: created.revision }
            : verb === 'field'
              ? { type, schemaId: created.recordId, expectedRevision: created.revision, definition: { type: 'number' } }
              : { type, schemaId: created.recordId, expectedRevision: created.revision, option: { kind: 'add', label: 'Small' } });
      expect(parsed.ok, `${type} must parse`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.verb).toBe(verb);
      expect(parsed.actionType).toBe(type);
    }

    // The five types are distinct, and a type is never claimed by two verbs.
    const types = Object.values(PROPERTY_SCHEMA_ACTION_TYPES);
    expect(new Set(types).size).toBe(types.length);
  });
});
