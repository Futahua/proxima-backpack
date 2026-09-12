/**
 * The schema editor's half of the three schema rows: the projection a surface draws, and the submissions a
 * form's Save sends.
 *
 * The rows themselves say what this is for - `tests/actionCoverageAudit.test.ts` asserted for the whole life of
 * the matrix that **no surface reaches** `createPropertySchema`, `updatePropertySchema`, `deletePropertySchema`,
 * `updateSchemaOption` or `updateSchemaField`, so the gap could not quietly become a claim. Closing it means a
 * UI caller exists, and this file is what proves the caller can actually reach those verbs: every case below
 * runs a submission through `submitPropertySchemaAction` - the same entry the agent wire uses - against a real
 * store, so what is asserted is that the form's output is a submission the entry *accepts and executes*, not
 * that a helper returned an object of the expected shape.
 *
 * Three things are deliberately not asserted here because they are not this layer's:
 * whether a name is acceptable, whether a definition is real, and whether a re-type would orphan stored values.
 * Those are the record layer's refusals and its own suite covers them.
 */
import { describe, expect, it } from 'vitest';
import {
  propertySchemaEditor,
  schemaAddOptionSubmission,
  schemaCreateOptionSubmissions,
  schemaCreateSubmission,
  schemaDefinitionFor,
  schemaDeleteSubmission,
  schemaOptionLabelsFrom,
  schemaRenameSubmission,
  PROPERTY_SCHEMA_CREATABLE_TYPES,
  PROPERTY_SCHEMA_EDITOR_TYPES,
  PROPERTY_SCHEMA_OPTION_TYPES,
} from '../src/app/propertySchemaEditor.js';
import { submitPropertySchemaAction, type PropertySchemaWriteOperations } from '../src/app/propertySchemaActions.js';
import {
  createPropertySchema,
  deletePropertySchema,
  updatePropertySchema,
  updateSchemaField,
  updateSchemaOption,
  type PropertySchemaMutationDependencies,
} from '../src/app/propertySchemaMutations.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import {
  opaqueRecordIdFromRandomBytes,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  opaqueSchemaOptionIdFromRandomBytes,
  parseOpaqueSchemaOptionId,
  type CanonicalPropertySchemaRecord,
  type OpaqueSchemaOptionId,
} from '../src/domain/canonicalSchema.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T10:00:00+07:00';

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

/** A world whose only job is to be a real record layer for the editor's submissions to reach. */
async function world() {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = 2500;
  let nextOption = 60;
  const deps: PropertySchemaMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    allocateRecordId: () => idFromLastByte(nextId++),
    allocateOptionId: () => optionIdFromLastByte(nextOption++),
  };
  const writes: PropertySchemaWriteOperations = {
    createPropertySchema: (request) => createPropertySchema(deps, request),
    updatePropertySchema: (input) => updatePropertySchema(deps, input),
    updateSchemaField: (input) => updateSchemaField(deps, input),
    updateSchemaOption: (input) => updateSchemaOption(deps, input),
    deletePropertySchema: (input) => deletePropertySchema(deps, input),
  };

  return {
    /** The editor's own Save, run through the entry the agent wire uses. */
    submit: async (submission: unknown) => await submitPropertySchemaAction(
      {
        writes: async () => writes,
        unavailableReason: () => null,
        ids: semanticIds(),
        audit: recordingAudit(),
      },
      submission,
    ),
    /** The records an editor would be handed, which is what `propertySchemaEditor` reads. */
    declared: async (): Promise<readonly { record: CanonicalPropertySchemaRecord; revision: string }[]> => {
      const loaded = await recordStoreStateSource(store).load();
      const records: { record: CanonicalPropertySchemaRecord; revision: string }[] = [];
      for (const schema of loaded.state.taskSchema) {
        const observation = await store.read(schema.id as OpaqueRecordId);
        if (observation === undefined || observation === null || observation.record.kind !== 'schema') continue;
        records.push({ record: observation.record as CanonicalPropertySchemaRecord, revision: observation.observedRevision });
      }
      return records;
    },
  };
}

describe('the schema editor projects what it can change and nothing it cannot', () => {
  it('offers four types it can create and lists the ones that need a chooser it does not have', () => {
    // The creatable set is a subset of the offered set, and the difference is the point: a relation, a rollup
    // and a formula each need a target this form cannot choose, so they are listed as types a *schema* may have
    // and not as types this form may create. A surface that offered them would promise a definition it cannot
    // build, and `schemaDefinitionFor` returning null is how that promise is kept rather than broken at Save.
    expect(PROPERTY_SCHEMA_EDITOR_TYPES).toEqual([
      'text', 'number', 'date', 'checkbox', 'select', 'multi-select', 'relation', 'rollup', 'formula',
    ]);
    expect(PROPERTY_SCHEMA_CREATABLE_TYPES).toEqual(['text', 'number', 'date', 'checkbox', 'select', 'multi-select']);
    expect(PROPERTY_SCHEMA_OPTION_TYPES).toEqual(['select', 'multi-select']);
    for (const type of PROPERTY_SCHEMA_CREATABLE_TYPES) {
      expect(schemaDefinitionFor(type)).not.toBeNull();
    }
    for (const type of ['relation', 'rollup', 'formula', 'nonsense']) {
      expect(schemaDefinitionFor(type)).toBeNull();
    }
    // A select is created with no options, because a canonical option needs an id the record layer allocates.
    expect(schemaDefinitionFor('select')).toEqual({ type: 'select', options: [] });
  });

  it('reads labels out of a form field, dropping the blanks a comma leaves behind', () => {
    // A trailing comma is a typo rather than a request for an unnamed option, and the record layer's own
    // sentence about labels is about labels - so this is where a comma stops being the reader's problem.
    expect(schemaOptionLabelsFrom('Alpha, Beta ,Gamma')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(schemaOptionLabelsFrom('Alpha,,Beta,')).toEqual(['Alpha', 'Beta']);
    expect(schemaOptionLabelsFrom('   ')).toEqual([]);
    expect(schemaOptionLabelsFrom('')).toEqual([]);
  });

  it('creates a schema through the same entry the agent wire uses, then adds its labels one at a time', async () => {
    const app = await world();

    // The create: a submission the entry accepts and executes against a real store.
    const created = await app.submit(schemaCreateSubmission({ name: 'Story points', type: 'number', options: '' }));
    expect(created).toMatchObject({ ok: true, verb: 'create', actionType: 'property.schema.create', outcome: 'created' });
    if (!created.ok) throw new Error('the create was refused');
    expect(created.requestId).toMatch(/^semantic-request/);

    // A plain type needs no follow-up submissions, which is asserted rather than assumed: a caller that ran the
    // option step for every type would append mutations nobody asked for.
    expect(schemaCreateOptionSubmissions({ name: 'Story points', type: 'number', options: 'ignored' }, created.recordId, created.revision)).toEqual([]);

    // A select needs one per label, and each names the revision the create returned - so the sequence is a
    // create followed by N option verbs, never N verbs that guess the new record's id.
    const select = await app.submit(schemaCreateSubmission({ name: 'Stage', type: 'select', options: '' }));
    if (!select.ok) throw new Error('the select create was refused');
    // The helper answers "which labels does this form carry", at the revision the create returned. What it does
    // *not* answer is the whole sequence's revisions, and that is a real constraint rather than a limitation of
    // the helper: each option write creates the revision the next one must name, so a caller runs them one at a
    // time against the revision it last saw.
    const labelSubmissions = schemaCreateOptionSubmissions({ name: 'Stage', type: 'select', options: 'Todo, Doing' }, select.recordId, select.revision);
    expect(labelSubmissions).toHaveLength(2);
    expect(labelSubmissions[0]).toMatchObject({ type: 'property.schema.option.change', schemaId: select.recordId, expectedRevision: select.revision, option: { kind: 'add', label: 'Todo' } });
    expect(labelSubmissions[1]).toMatchObject({ option: { kind: 'add', label: 'Doing' } });

    let revision = select.revision;
    for (const label of ['Todo', 'Doing']) {
      const added = await app.submit(schemaAddOptionSubmission({ schemaId: select.recordId, revision, label }));
      expect(added).toMatchObject({ ok: true, verb: 'option', actionType: 'property.schema.option.change' });
      if (!added.ok) throw new Error(`the option add for ${label} was refused: ${added.detail}`);
      revision = added.revision;
    }

    // The editor now draws both, and the select's labels are the ones that were added - read out of the records
    // rather than out of the results, because the projection is what the surface will actually draw.
    const projection = propertySchemaEditor(await app.declared());
    expect(projection.declaredCount).toBe(2);
    const rows = projection.rows;
    expect(rows.map((row) => row.name)).toEqual(['Story points', 'Stage']);
    expect(rows[0]).toMatchObject({ type: 'number', options: [], detail: null, typeEditable: true });
    expect(rows[1]!.options.map((option) => option.label)).toEqual(['Todo', 'Doing']);
    // Every row carries the revision a write must name, which is the field the legacy projection could not
    // supply and the reason this module reads the records instead.
    expect(rows.every((row) => typeof row.revision === 'string' && row.revision !== '')).toBe(true);
    expect(rows[1]!.revision).toBe(revision);
  });

  it('renames, adds an option and deletes through the entry, at the revision the row was drawn from', async () => {
    const app = await world();
    const created = await app.submit(schemaCreateSubmission({ name: 'Priority', type: 'select', options: '' }));
    if (!created.ok) throw new Error('the create was refused');

    // Rename, at the revision the row carries rather than at a guess.
    const row = propertySchemaEditor(await app.declared()).rows[0]!;
    const renamed = await app.submit(schemaRenameSubmission({ schemaId: row.schemaId, revision: row.revision, name: 'Urgency' }));
    expect(renamed).toMatchObject({ ok: true, verb: 'update', outcome: 'updated' });
    if (!renamed.ok) throw new Error('the rename was refused');
    expect(propertySchemaEditor(await app.declared()).rows[0]!.name).toBe('Urgency');

    // Add one option, which is the shape of the verb: an option is what a stored value points at, so two at a
    // time would be two mutations wearing one submission's clothes.
    const added = await app.submit(schemaAddOptionSubmission({ schemaId: row.schemaId, revision: renamed.revision, label: 'High' }));
    expect(added).toMatchObject({ ok: true, verb: 'option' });
    if (!added.ok) throw new Error('the option add was refused');
    expect(propertySchemaEditor(await app.declared()).rows[0]!.options.map((option) => option.label)).toEqual(['High']);

    // A lost race is the editor's own case rather than a hypothetical one: the row it drew is now stale, and
    // the refusal names the revision that beat it so the surface can refetch instead of guessing.
    const stale = await app.submit(schemaRenameSubmission({ schemaId: row.schemaId, revision: row.revision, name: 'Too late' }));
    expect(stale).toMatchObject({ ok: false, reason: 'stale-revision', actualRevision: added.revision });

    // Delete, at the current revision, and the row is gone from what the editor would draw.
    const deleted = await app.submit(schemaDeleteSubmission(row.schemaId, added.revision));
    expect(deleted).toMatchObject({ ok: true, verb: 'delete', outcome: 'deleted' });
    expect(propertySchemaEditor(await app.declared()).declaredCount).toBe(0);
  });

  it('passes a blank label through to the record layer rather than refusing it here', async () => {
    // The division the module's own header states, asserted rather than described: this layer validates
    // nothing, so a blank label reaches the record layer and comes back in *its* words. A helper that refused
    // it locally would be a second copy of a rule the record layer already owns, and the two would drift.
    const app = await world();
    const created = await app.submit(schemaCreateSubmission({ name: 'Blank', type: 'select', options: '' }));
    if (!created.ok) throw new Error('the create was refused');

    const blank = await app.submit(schemaAddOptionSubmission({ schemaId: created.recordId, revision: created.revision, label: '   ' }));
    expect(blank).toMatchObject({ ok: false, reason: 'validation-refused' });
    if (blank.ok) throw new Error('a blank label was accepted');
    // The sentence is the record layer's, and it is the subject the record layer names: an *option* needs a
    // name, not a schema. A helper here that refused the blank locally would be a second copy of a rule the
    // record layer already owns, and the two copies would drift the first time one of them changed.
    expect(blank.detail).toBe('a option needs a name');
  });

  it('offers the same option ids the records carry, so a caller can name one it did not invent', async () => {
    const app = await world();
    const created = await app.submit(schemaCreateSubmission({ name: 'Tags', type: 'multi-select', options: '' }));
    if (!created.ok) throw new Error('the create was refused');
    const added = await app.submit(schemaAddOptionSubmission({ schemaId: created.recordId, revision: created.revision, label: 'One' }));
    if (!added.ok) throw new Error('the option add was refused');

    const option = propertySchemaEditor(await app.declared()).rows[0]!.options[0]!;
    // The id a surface reads out of a data attribute is the canonical id, parseable as one - which is what
    // makes a rename or a remove reachable from a row without the surface inventing an identity.
    expect(() => parseOpaqueSchemaOptionId(option.optionId)).not.toThrow();
    expect(option.optionId).toBe(parseOpaqueSchemaOptionId(option.optionId));
    expect(option.label).toBe('One');
  });
});
