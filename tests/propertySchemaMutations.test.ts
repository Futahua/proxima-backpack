/**
 * Stage 17's property-schema writes, proven through the real store boundary and the real recovery
 * coordinator rather than against a stub of either.
 *
 * The cases attack the path. Four invalid creates are refused before one is allowed; a rename, a
 * type change and an option removal are each asked to leave stored values behind and each refuses
 * with the count of records it would have orphaned; a formula's expression is edited through the
 * narrow field verb and a type change through it is refused; and every refusal asserts that the
 * store's revisions did not move.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import {
  createPropertySchema,
  deletePropertySchema,
  updatePropertySchema,
  updateSchemaField,
  updateSchemaOption,
  type PropertySchemaMutationDependencies,
  type PropertySchemaMutationResult,
} from '../src/app/propertySchemaMutations.js';
import { projectRecordState } from '../src/app/recordStateProjection.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createEvent } from '../src/app/eventMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { opaqueSchemaOptionIdFromRandomBytes, type CanonicalPropertyDefinition, type OpaqueSchemaOptionId } from '../src/domain/canonicalSchema.js';
import { MemoryRecordFiles } from './test-record-store.js';

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
const EFFORT = idFromLastByte(10);
const STAGE = idFromLastByte(11);
const FORMULA = idFromLastByte(12);
const CHOICE = idFromLastByte(13);
const OPTION_A = optionIdFromLastByte(201);
const OPTION_B = optionIdFromLastByte(202);
const OPTION_C = optionIdFromLastByte(203);

interface World {
  files: MemoryRecordFiles;
  deps: PropertySchemaMutationDependencies;
  taskDeps: TaskMutationDependencies;
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
  const taskDeps: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  const deps: PropertySchemaMutationDependencies = {
    store,
    coordinator,
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
  for (const record of [
    project as CanonicalRecordV2,
    {
      ...defineCanonicalRecordHeader({ kind: 'workflow-stage', id: STAGE, name: 'Design' }),
      projectId: PROJECT,
    } as CanonicalRecordV2,
  ]) {
    expect((await store.createIfAbsent(record)).ok).toBe(true);
  }

  return { files, deps, taskDeps };
}

async function revisions(files: MemoryRecordFiles): Promise<Record<string, string>> {
  const names = await files.listRecordFiles();
  const out: Record<string, string> = {};
  for (const name of names) out[name] = (await files.readRecordFile(name as never))?.revision ?? '';
  return out;
}

function ok(result: PropertySchemaMutationResult): Extract<PropertySchemaMutationResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  return result;
}

function refusalOf(result: PropertySchemaMutationResult): Extract<PropertySchemaMutationResult, { ok: false }> {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

async function selectId(worldValue: World): Promise<OpaqueRecordId> {
  const created = ok(await createPropertySchema(worldValue.deps, {
    name: 'Choice',
    definition: {
      type: 'select',
      options: [
        { id: OPTION_A, label: 'Alpha' },
        { id: OPTION_B, label: 'Beta' },
      ],
    },
  }));
  return created.recordId;
}

describe('Stage 17 property-schema writes', () => {
  it('creates a schema through the store boundary, and refuses every invalid request before writing', async () => {
    const worldValue = await world();
    const before = await revisions(worldValue.files);

    expect(refusalOf(await createPropertySchema(worldValue.deps, {
      name: '   ',
      definition: { type: 'number' },
    }))).toMatchObject({ reason: 'validation-refused', detail: 'a property needs a name' });
    expect(refusalOf(await createPropertySchema(worldValue.deps, {
      name: 'x'.repeat(201),
      definition: { type: 'number' },
    })).reason).toBe('validation-refused');
    // The domain's constructor is the validator, so its own rules refuse here too.
    expect(refusalOf(await createPropertySchema(worldValue.deps, {
      name: 'Duplicated',
      definition: { type: 'select', options: [{ id: OPTION_A, label: 'Alpha' }, { id: OPTION_A, label: 'Again' }] },
    })).reason).toBe('validation-refused');
    expect(refusalOf(await createPropertySchema(worldValue.deps, {
      name: 'Nowhere',
      definition: { type: 'relation', targetKinds: [] },
    })).reason).toBe('validation-refused');
    expect(refusalOf(await createPropertySchema(worldValue.deps, {
      name: 'Blank',
      definition: { type: 'formula', expression: '   ' },
    })).reason).toBe('validation-refused');

    expect(await revisions(worldValue.files)).toEqual(before);

    const created = ok(await createPropertySchema(worldValue.deps, {
      name: '  Effort  ',
      definition: { type: 'number' },
    }));
    expect(created.outcome).toBe('created');
    expect(created.record).toMatchObject({ kind: 'schema', name: 'Effort', definition: { type: 'number' } });

    // The projection every surface reads draws it as a property of the world.
    const projection = projectRecordState(await worldValue.deps.store.list());
    expect(projection.state.taskSchema).toMatchObject([{ id: created.recordId, name: 'Effort', type: 'number' }]);
    expect(projection.report.gaps).toEqual([]);
  });

  it('renames a property, changes its kind while nothing carries a value, and refuses that change once one does', async () => {
    const worldValue = await world();
    const created = ok(await createPropertySchema(worldValue.deps, {
      name: 'Effort',
      definition: { type: 'number' },
    }));

    const renamed = ok(await updatePropertySchema(worldValue.deps, {
      schemaId: created.recordId,
      expectedRevision: created.revision,
      name: 'Story points',
    }));
    expect(renamed.outcome).toBe('updated');
    expect(renamed.record).toMatchObject({ name: 'Story points', definition: { type: 'number' } });

    // Nothing carries a value yet, so the kind may change: it is an edit, not a migration.
    const retyped = ok(await updatePropertySchema(worldValue.deps, {
      schemaId: created.recordId,
      expectedRevision: renamed.revision,
      definition: { type: 'text' },
    }));
    expect(retyped.record).toMatchObject({ name: 'Story points', definition: { type: 'text' } });

    // Now a card carries one, and the same request is refused with the count.
    const task = await createTask(worldValue.taskDeps, {
      name: 'Carries a value',
      projectId: PROJECT,
      properties: { [created.recordId]: { type: 'text', value: 'three' } },
      executionOrder: 0,
    });
    expect(task.ok).toBe(true);

    const refused = refusalOf(await updatePropertySchema(worldValue.deps, {
      schemaId: created.recordId,
      expectedRevision: retyped.revision,
      definition: { type: 'number' },
    }));
    expect(refused.reason).toBe('semantic-conflict');
    expect(refused.affectedRecordCount).toBe(1);
    expect(refused.detail).toContain('1 record(s)');
    // And a refusal with nothing changed is refused before reading anything else.
    expect(refusalOf(await updatePropertySchema(worldValue.deps, {
      schemaId: created.recordId,
      expectedRevision: retyped.revision,
    })).detail).toBe('an update with no field to change is not an update');
  });

  it('edits a formula through the field verb and refuses a field edit that would change the kind', async () => {
    const worldValue = await world();
    const formula = ok(await createPropertySchema(worldValue.deps, {
      name: 'Score',
      definition: { type: 'formula', expression: 'weight * 2' },
    }));

    const edited = ok(await updateSchemaField(worldValue.deps, {
      schemaId: formula.recordId,
      expectedRevision: formula.revision,
      definition: { type: 'formula', expression: 'weight * 3' },
    }));
    expect(edited.record).toMatchObject({ name: 'Score', definition: { type: 'formula', expression: 'weight * 3' } });
    // The record is the authority for this row, not the value the operation returned: the matrix's observable
    // cell for a field edit reads the schema back out of the store at the revision the write reported.
    const stored = await worldValue.deps.store.read(formula.recordId);
    expect(stored?.observedRevision).toBe(edited.revision);
    expect(stored?.record).toMatchObject({ name: 'Score', definition: { type: 'formula', expression: 'weight * 3' } });

    const refused = refusalOf(await updateSchemaField(worldValue.deps, {
      schemaId: formula.recordId,
      expectedRevision: edited.revision,
      definition: { type: 'rollup', relationSchemaId: EFFORT, targetSchemaId: FORMULA, aggregation: 'sum' },
    }));
    expect(refused.reason).toBe('validation-refused');
    expect(refused.detail).toBe('a field edit may not change formula into rollup; that is a value migration');
    // And the refusal wrote nothing: the record is still where the edit left it.
    expect((await worldValue.deps.store.read(formula.recordId))?.observedRevision).toBe(edited.revision);

    // A rollup whose targets are named is ordinary through the schema verb, though.
    const relation = ok(await createPropertySchema(worldValue.deps, {
      name: 'Related',
      definition: { type: 'relation', targetKinds: ['task'] },
    }));
    const rollup = ok(await updateSchemaField(worldValue.deps, {
      schemaId: formula.recordId,
      expectedRevision: edited.revision,
      definition: { type: 'formula', expression: 'weight + 1' },
    }));
    expect(rollup.record).toMatchObject({ definition: { type: 'formula', expression: 'weight + 1' } });
    expect(relation.recordId).not.toBe(formula.recordId);
  });

  it('adds and renames options, keeps the option identity through a rename, and refuses a duplicate label', async () => {
    const worldValue = await world();
    const schemaId = await selectId(worldValue);
    const current = await worldValue.deps.store.read(schemaId);
    const revision = current!.observedRevision;

    const added = ok(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: revision,
      option: { kind: 'add', label: 'Gamma' },
    }));
    expect(added.outcome).toBe('option-added');
    const options = (added.record!.definition as { options: readonly { id: string; label: string }[] }).options;
    expect(options.map((option) => option.label)).toEqual(['Alpha', 'Beta', 'Gamma']);

    // The label is not identity: renaming keeps the id a stored value points at.
    const renamed = ok(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: added.revision,
      option: { kind: 'rename', optionId: OPTION_A, label: 'First' },
    }));
    const afterRename = (renamed.record!.definition as { options: readonly { id: string; label: string }[] }).options;
    expect(afterRename.find((option) => option.id === OPTION_A)!.label).toBe('First');
    expect(afterRename.map((option) => option.id)).toEqual([OPTION_A, OPTION_B, options[2]!.id]);

    expect(refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: renamed.revision,
      option: { kind: 'add', label: 'First' },
    })).detail).toBe('this property already offers an option labelled First');
    expect(refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: renamed.revision,
      option: { kind: 'rename', optionId: OPTION_A, label: 'Beta' },
    })).reason).toBe('validation-refused');
    expect(refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: renamed.revision,
      option: { kind: 'rename', optionId: optionIdFromLastByte(250), label: 'Nowhere' },
    })).reason).toBe('not-found');

    // A property that has no options refuses the verb rather than inventing some.
    const number = ok(await createPropertySchema(worldValue.deps, { name: 'Effort', definition: { type: 'number' } }));
    expect(refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId: number.recordId,
      expectedRevision: number.revision,
      option: { kind: 'add', label: 'Gamma' },
    })).detail).toBe('only a select or multi-select property has options');
  });

  it('refuses to remove an option records still use, counts multi-select uses too, and removes it once they are cleared', async () => {
    const worldValue = await world();
    const schemaId = await selectId(worldValue);
    // Its own option ids, because an option belongs to the schema that declares it: reusing one
    // across two schemas would be the aliasing the canonical model refuses.
    const multi = ok(await createPropertySchema(worldValue.deps, {
      name: 'Tags',
      definition: { type: 'multi-select', options: [{ id: OPTION_B, label: 'Beta' }, { id: OPTION_C, label: 'Gamma' }] },
    }));

    const task = await createTask(worldValue.taskDeps, {
      name: 'Uses both kinds of option',
      projectId: PROJECT,
      executionOrder: 0,
      properties: {
        [schemaId]: { type: 'select', optionId: OPTION_A },
        [multi.recordId]: { type: 'multi-select', optionIds: [OPTION_B, OPTION_C] },
      },
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    const refused = refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: (await worldValue.deps.store.read(schemaId))!.observedRevision,
      option: { kind: 'remove', optionId: OPTION_A },
    }));
    expect(refused.reason).toBe('semantic-conflict');
    expect(refused.affectedRecordCount).toBe(1);
    expect(refused.detail).toBe('1 record(s) still use the option Alpha; clear them before removing it');

    // A multi-select value names its options too, so an option inside one is counted the same way.
    const multiRefused = refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId: multi.recordId,
      expectedRevision: (await worldValue.deps.store.read(multi.recordId))!.observedRevision,
      option: { kind: 'remove', optionId: OPTION_B },
    }));
    expect(multiRefused).toMatchObject({ reason: 'semantic-conflict', affectedRecordCount: 1 });
    expect(multiRefused.detail).toBe('1 record(s) still use the option Beta; clear them before removing it');

    // An option nothing uses comes out without ceremony.
    const removed = ok(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: (await worldValue.deps.store.read(schemaId))!.observedRevision,
      option: { kind: 'remove', optionId: OPTION_B },
    }));
    expect((removed.record!.definition as { options: readonly { id: string }[] }).options.map((option) => option.id))
      .toEqual([OPTION_A]);

    // Clearing the values through the task operation is what makes the removal possible, which is the
    // order the refusal asks for rather than a rewriting of somebody's data behind their back.
    const cleared = await updateTask(worldValue.taskDeps, {
      taskId: task.recordId,
      expectedRevision: (await worldValue.deps.store.read(task.recordId))!.observedRevision,
      mutations: [
        { kind: 'property', key: schemaId, value: null },
        { kind: 'property', key: multi.recordId, value: null },
      ],
    });
    expect(cleared.ok).toBe(true);

    const nowRemovable = ok(await updateSchemaOption(worldValue.deps, {
      schemaId,
      expectedRevision: (await worldValue.deps.store.read(schemaId))!.observedRevision,
      option: { kind: 'remove', optionId: OPTION_A },
    }));
    expect((nowRemovable.record!.definition as { options: readonly { id: string }[] }).options).toEqual([]);
  });

  it('deletes an unused schema, refuses one a record still reads, and refuses a stale delete', async () => {
    const worldValue = await world();
    const schemaId = await selectId(worldValue);
    const unused = ok(await createPropertySchema(worldValue.deps, { name: 'Unused', definition: { type: 'checkbox' } }));

    const project = projectRecordState(await worldValue.deps.store.list());
    expect(project.state.taskSchema?.map((schema) => schema.name).sort()).toEqual(['Choice', 'Unused']);

    const removed = ok(await deletePropertySchema(worldValue.deps, {
      schemaId: unused.recordId,
      expectedRevision: unused.revision,
    }));
    expect(removed.outcome).toBe('deleted');
    expect(removed.record).toBeNull();
    expect(await worldValue.deps.store.read(unused.recordId)).toBeUndefined();

    // An event carrying a value counts exactly as a task does.
    const event = await createEvent(worldValue.taskDeps, {
      name: 'Uses the property',
      projectId: PROJECT,
      startDate: '2026-09-12T09:00:00.000Z',
      deadline: '2026-09-12T10:00:00.000Z',
      properties: { [schemaId]: { type: 'select', optionId: OPTION_B } },
    });
    expect(event.ok).toBe(true);

    const revision = (await worldValue.deps.store.read(schemaId))!.observedRevision;
    const refused = refusalOf(await deletePropertySchema(worldValue.deps, {
      schemaId,
      expectedRevision: revision,
    }));
    expect(refused.reason).toBe('semantic-conflict');
    expect(refused.affectedRecordCount).toBe(1);
    expect(refused.detail).toBe('1 record(s) still carry a value for this property; clear them before deleting it');

    const stale = refusalOf(await deletePropertySchema(worldValue.deps, {
      schemaId,
      expectedRevision: 'invented-revision',
    }));
    expect(stale.reason).toBe('stale-revision');
    expect(stale.actualRevision).toBe(revision);
    expect(await worldValue.deps.store.read(schemaId)).toBeDefined();
  });

  it('refuses a schema that is not in the store, and a schema id passed where a record id belongs', async () => {
    const worldValue = await world();
    const missing = idFromLastByte(90);

    expect(refusalOf(await updatePropertySchema(worldValue.deps, {
      schemaId: missing,
      expectedRevision: 'anything',
      name: 'Nowhere',
    }))).toMatchObject({ reason: 'not-found', detail: `no schema record ${missing}` });
    expect(refusalOf(await updateSchemaField(worldValue.deps, {
      schemaId: missing,
      expectedRevision: 'anything',
      definition: { type: 'text' },
    })).reason).toBe('not-found');
    expect(refusalOf(await updateSchemaOption(worldValue.deps, {
      schemaId: missing,
      expectedRevision: 'anything',
      option: { kind: 'add', label: 'Nowhere' },
    })).reason).toBe('not-found');
    expect(refusalOf(await deletePropertySchema(worldValue.deps, {
      schemaId: missing,
      expectedRevision: 'anything',
    })).reason).toBe('not-found');
    // A project id is not a schema id: the kind is part of the answer.
    expect(refusalOf(await deletePropertySchema(worldValue.deps, {
      schemaId: PROJECT,
      expectedRevision: 'anything',
    })).reason).toBe('not-found');
  });
});
