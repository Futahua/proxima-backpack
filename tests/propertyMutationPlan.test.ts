/**
 * Custom-property edits: what a form holds, and what the record ends up storing.
 *
 * The interesting half of these cases is the **round trip**: a value goes into the store as
 * canonical data, comes out through the compatibility projection as whatever a form can show (a
 * select's *label*, a relation's record ids), gets edited, and is mapped back. A mapping that only
 * worked in one direction would still pass a unit test written against the form's own vocabulary,
 * so the last case does the whole loop through the real store and the real recovery gate and asks
 * both ends what they hold.
 *
 * The other half is the refusals, because a wrong mapping here does not fail loudly: it writes a
 * value nobody chose, or clears one that was never wrong.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { planPropertyMutation } from '../src/app/propertyMutationPlan.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { applyTaskEditorEdit, taskEditorDraftFor } from '../src/app/taskEditor.js';
import { planTaskEditorSave, saveTaskAction } from '../src/app/taskEditorWrite.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { defineCanonicalPropertySchema, opaqueSchemaOptionIdFromRandomBytes, type CanonicalPropertySchemaRecord } from '../src/domain/canonicalSchema.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { PropertySchema, ProximaState } from '../src/domain/types.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T06:30:00+07:00';

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

function optionFromLastByte(value: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueSchemaOptionIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(61);
const AREA = idFromLastByte(62);
const ESTIMATE = idFromLastByte(63);
const DUE = idFromLastByte(64);
const FLAGGED = idFromLastByte(65);
const EFFORT = idFromLastByte(66);
const TAGS = idFromLastByte(67);
const BLOCKS = idFromLastByte(68);
const CHILD_COUNT = idFromLastByte(69);
const WORK = optionFromLastByte(1);
const HOME = optionFromLastByte(2);
const URGENT = optionFromLastByte(3);
const LATER = optionFromLastByte(4);

const schemaOf = (id: OpaqueRecordId, name: string, type: PropertySchema['type'], options?: { id: string; name: string }[]): PropertySchema => ({
  id,
  name,
  type,
  // Option colour is local presentation state under A5, so a schema built for a case carries a
  // blank one rather than inventing a colour the record does not have.
  ...(options === undefined ? {} : { options: options.map((option) => ({ ...option, color: '' })) }),
});

const AREA_SCHEMA = schemaOf(AREA, 'Area', 'select', [{ id: WORK, name: 'Work' }, { id: HOME, name: 'Home' }]);
const TAGS_SCHEMA = schemaOf(TAGS, 'Tags', 'multi-select', [{ id: URGENT, name: 'Urgent' }, { id: LATER, name: 'Later' }]);

describe('Stage 10 planPropertyMutation', () => {
  it('maps a text, a number and a date, and reads a blank as a clear', () => {
    expect(planPropertyMutation(schemaOf(ESTIMATE, 'Note', 'text'), { value: 'hello', checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'text', value: 'hello' } });
    expect(planPropertyMutation(schemaOf(ESTIMATE, 'Note', 'text'), { value: '   ', checked: false, selected: [] })).toMatchObject({ ok: true, value: null });

    expect(planPropertyMutation(schemaOf(ESTIMATE, 'Estimate', 'number'), { value: '2.5', checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'number', value: 2.5 } });
    expect(planPropertyMutation(schemaOf(ESTIMATE, 'Estimate', 'number'), { value: '', checked: false, selected: [] })).toMatchObject({ ok: true, value: null });
    expect(planPropertyMutation(schemaOf(ESTIMATE, 'Estimate', 'number'), { value: 'lots', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'validation-refused' });

    expect(planPropertyMutation(schemaOf(DUE, 'Due', 'date'), { value: '2026-10-01', checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'date', value: '2026-10-01' } });
    expect(planPropertyMutation(schemaOf(DUE, 'Due', 'date'), { value: 'someday', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'validation-refused' });
  });

  it('treats a checkbox as a value, including false', () => {
    expect(planPropertyMutation(schemaOf(FLAGGED, 'Flagged', 'checkbox'), { value: '', checked: true, selected: [] })).toMatchObject({ ok: true, value: { type: 'checkbox', value: true } });
    // False is a value: a form has no way to say "unset" about a checkbox, so it must not clear.
    expect(planPropertyMutation(schemaOf(FLAGGED, 'Flagged', 'checkbox'), { value: '', checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'checkbox', value: false } });
  });

  it('matches an option by id first and by label second, and refuses a label that is neither', () => {
    expect(planPropertyMutation(AREA_SCHEMA, { value: 'Work', checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'select', optionId: WORK } });
    // A value that is already an option id is still that option — the projection wrote labels, but
    // treating an id as an unmatched label would clear a value that was never wrong.
    expect(planPropertyMutation(AREA_SCHEMA, { value: WORK, checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'select', optionId: WORK } });
    expect(planPropertyMutation(AREA_SCHEMA, { value: '', checked: false, selected: [] })).toMatchObject({ ok: true, value: null });
    expect(planPropertyMutation(AREA_SCHEMA, { value: 'Nowhere', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'validation-refused' });
  });

  it('maps a multi-select from its labels, and clears when nothing is chosen', () => {
    expect(planPropertyMutation(TAGS_SCHEMA, { value: '', checked: false, selected: ['Urgent', 'Later'] })).toMatchObject({ ok: true, value: { type: 'multi-select', optionIds: [URGENT, LATER] } });
    expect(planPropertyMutation(TAGS_SCHEMA, { value: '', checked: false, selected: [] })).toMatchObject({ ok: true, value: null });
    expect(planPropertyMutation(TAGS_SCHEMA, { value: '', checked: false, selected: ['Urgent', 'Nope'] })).toMatchObject({ ok: false, reason: 'validation-refused' });
  });

  it('holds record ids in a relation, and refuses a name', () => {
    const blocks = schemaOf(BLOCKS, 'Blocks', 'relation');
    const target = idFromLastByte(70);
    const planned = planPropertyMutation(blocks, { value: `${target}`, checked: false, selected: [] });
    expect(planned).toMatchObject({ ok: true, value: { type: 'relation', value: { relationSchemaId: BLOCKS, targetRecordIds: [target] } } });
    // Comma-separated, because that is how the field shows more than one.
    expect(planPropertyMutation(blocks, { value: `${target}, ${idFromLastByte(71)}`, checked: false, selected: [] })).toMatchObject({ ok: true, value: { type: 'relation', value: { targetRecordIds: [target, idFromLastByte(71)] } } });
    expect(planPropertyMutation(blocks, { value: '', checked: false, selected: [] })).toMatchObject({ ok: true, value: null });
    // A6: a relation is ids. A name would have to be resolved, and a relation that guessed would
    // point at a record nobody chose.
    expect(planPropertyMutation(blocks, { value: 'Some task name', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'validation-refused' });
  });

  it('refuses a derived value and a property with no schema at all', () => {
    const rollup: PropertySchema = { id: CHILD_COUNT, name: 'Children', type: 'rollup' };
    const formula: PropertySchema = { id: CHILD_COUNT, name: 'Progress', type: 'formula' };
    expect(planPropertyMutation(rollup, { value: '4', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'unsupported-field' });
    expect(planPropertyMutation(formula, { value: '50%', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'unsupported-field' });
    expect(planPropertyMutation(undefined, { value: 'anything', checked: false, selected: [] })).toMatchObject({ ok: false, reason: 'unknown-schema' });
  });
});

describe('Stage 10 property round trip', () => {
  it('writes what the form held and reads it back through the projection', async () => {
    const files = new MemoryRecordFiles();
    const store = createCanonicalJsonRecordStore(files);
    const recovery = createDurableRecoveryStore(new MemoryJournal());
    const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
    if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

    let nextId = 70;
    const deps: TaskMutationDependencies = {
      store,
      coordinator: authority.coordinator,
      clock: fixedClock(CLOCK_ISO),
      allocateRecordId: () => idFromLastByte(nextId++),
    };

    const project: CanonicalProjectRecordV2 = {
      ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Project' }),
      description: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'active',
      archivedAt: null,
      artifactBindings: [],
    };
    await store.createIfAbsent(project as CanonicalRecordV2);

    // Every property type a form can edit, as canonical schema records.
    const schemas: CanonicalPropertySchemaRecord[] = [
      defineCanonicalPropertySchema({ header: defineCanonicalRecordHeader({ kind: 'schema', id: ESTIMATE, name: 'Estimate' }), definition: { type: 'number' } }),
      defineCanonicalPropertySchema({ header: defineCanonicalRecordHeader({ kind: 'schema', id: DUE, name: 'Due' }), definition: { type: 'date' } }),
      defineCanonicalPropertySchema({ header: defineCanonicalRecordHeader({ kind: 'schema', id: FLAGGED, name: 'Flagged' }), definition: { type: 'checkbox' } }),
      defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id: AREA, name: 'Area' }),
        definition: { type: 'select', options: [{ id: WORK, label: 'Work' }, { id: HOME, label: 'Home' }] },
      }),
      defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id: TAGS, name: 'Tags' }),
        definition: { type: 'multi-select', options: [{ id: URGENT, label: 'Urgent' }, { id: LATER, label: 'Later' }] },
      }),
      defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id: BLOCKS, name: 'Blocks' }),
        definition: { type: 'relation', targetKinds: ['task'] },
      }),
      defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id: CHILD_COUNT, name: 'Children' }),
        definition: { type: 'rollup', relationSchemaId: BLOCKS, targetSchemaId: ESTIMATE, aggregation: 'count' },
      }),
    ];
    for (const schema of schemas) await store.createIfAbsent(schema as CanonicalRecordV2);

    const created = await createTask(deps, {
      name: 'Round trip',
      projectId: PROJECT,
      executionState: 'backlog',
      executionOrder: 0,
      // Starting values, so the projection has something to show and the edit has something to keep.
      properties: {
        [ESTIMATE]: { type: 'number', value: 1 },
        [AREA]: { type: 'select', optionId: HOME },
      },
    });
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);

    const source = recordStoreStateSource(store);
    const refresh = createRefreshController({ initial: await source.load(), source });
    const read = async (): Promise<ProximaState> => (await source.load()).state;

    // What the form shows: the select's *label*, not its option id, and a number as a number.
    const before = (await read()).tasks[0]!;
    expect(before.properties[AREA]).toBe('Home');
    expect(before.properties[ESTIMATE]).toBe(1);
    // Which the editor's own projection turns into the text a control holds.
    expect(taskEditorDraftFor(before).values[`property:${ESTIMATE}`]).toBe('1');

    let draft = taskEditorDraftFor(before);
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${ESTIMATE}`, value: '3.5' });
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${DUE}`, value: '2026-11-01' });
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${FLAGGED}`, checked: true });
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${AREA}`, value: 'Work' });
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${TAGS}`, selected: ['Urgent', 'Later'] });
    draft = applyTaskEditorEdit(draft, { fieldId: `property:${BLOCKS}`, value: PROJECT });

    // The plan agrees with the schema before anything is written, and one mutation per field.
    const plan = planTaskEditorSave(before, draft, (await read()).taskSchema);
    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) {
      expect(plan.mutations).toHaveLength(6);
      expect(plan.mutations.every((mutation) => mutation.kind === 'property')).toBe(true);
    }

    const effect = await saveTaskAction(
      {
        state: await read(),
        writes: async () => ({
          updateTask: (request) => updateTask(deps, request),
          deleteTask: async () => { throw new Error('not used'); },
        }),
        unavailableReason: () => null,
        refresh: async (reason: RefreshReason): Promise<RefreshResult> => await refresh.refreshSource(reason),
        setRefusal: () => undefined,
        render: () => undefined,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      { taskId: created.recordId, draft },
    );
    expect(effect).toMatchObject({ outcome: { ok: true } });

    // The record holds canonical values: option *ids*, a relation naming its own schema, a real number.
    const stored = (await store.read(created.recordId))?.record as CanonicalTaskRecordV2;
    expect(stored.properties[ESTIMATE]).toEqual({ type: 'number', value: 3.5 });
    expect(stored.properties[DUE]).toEqual({ type: 'date', value: '2026-11-01' });
    expect(stored.properties[FLAGGED]).toEqual({ type: 'checkbox', value: true });
    expect(stored.properties[AREA]).toEqual({ type: 'select', optionId: WORK });
    expect(stored.properties[TAGS]).toEqual({ type: 'multi-select', optionIds: [URGENT, LATER] });
    expect(stored.properties[BLOCKS]).toEqual({ type: 'relation', value: { relationSchemaId: BLOCKS, targetRecordIds: [PROJECT] } });
    // And the rollup was never touched: it is derived, so it is not in the record at all.
    expect(stored.properties[CHILD_COUNT]).toBeUndefined();

    // The round trip closes: the projection shows what was typed, in the vocabulary a form uses —
    // a number as a number, an option as its label, a relation as record ids.
    const after = (await read()).tasks[0]!;
    expect(after.properties[ESTIMATE]).toBe(3.5);
    expect(taskEditorDraftFor(after).values[`property:${ESTIMATE}`]).toBe('3.5');
    expect(after.properties[DUE]).toBe('2026-11-01');
    expect(after.properties[FLAGGED]).toBe(true);
    expect(after.properties[AREA]).toBe('Work');
    expect(after.properties[TAGS]).toEqual(['Urgent', 'Later']);
    expect(after.properties[BLOCKS]).toEqual(PROJECT);
  });

  it('refuses a derived edit and an undeclared property before the writer is called', async () => {
    const files = new MemoryRecordFiles();
    const store = createCanonicalJsonRecordStore(files);
    const recovery = createDurableRecoveryStore(new MemoryJournal());
    const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
    if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

    const deps: TaskMutationDependencies = {
      store,
      coordinator: authority.coordinator,
      clock: fixedClock(CLOCK_ISO),
      allocateRecordId: () => idFromLastByte(80),
    };
    const created = await createTask(deps, { name: 'Refusals', projectId: null, executionState: 'backlog' });
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const source = recordStoreStateSource(store);
    const state = await source.load();

    const derived = planTaskEditorSave(
      state.state.tasks[0]!,
      applyTaskEditorEdit(taskEditorDraftFor(state.state.tasks[0]!), { fieldId: `property:${CHILD_COUNT}`, value: '4' }),
      [schemaOf(CHILD_COUNT, 'Children', 'rollup')],
    );
    expect(derived).toMatchObject({ ok: false, reason: 'unsupported-field', fieldId: `property:${CHILD_COUNT}` });

    const undeclared = planTaskEditorSave(
      state.state.tasks[0]!,
      applyTaskEditorEdit(taskEditorDraftFor(state.state.tasks[0]!), { fieldId: 'property:pxr_000000000000000000000000000000ff', value: 'x' }),
      [],
    );
    expect(undeclared).toMatchObject({ ok: false, reason: 'unknown-schema' });

    // Neither refusal reached the writer: the record is still at its first revision.
    expect((await store.read(created.recordId))?.observedRevision).toContain('@1');
  });
});
