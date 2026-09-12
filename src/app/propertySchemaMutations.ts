/**
 * Stage 17's property-schema editing: `schema.create`, `.update`, `.delete` and the two narrower
 * writes a schema needs — one option at a time, and a field definition that may not change what kind
 * of value the property holds.
 *
 * Schema records have existed canonically since the model was written and every surface reads them:
 * the Backlog draws a column per schema, the Task editor draws a field per schema. Nothing could
 * write one. That is the gap this module closes, in the shape `taskMutations` set.
 *
 * Three rules, and the third is the one worth reading.
 *
 * **The request is closed and typed**, and the definition is validated by the domain's own
 * constructor rather than by a second copy of its rules: a duplicate option id, an empty relation
 * target list or a blank formula is refused here with a sentence instead of reaching the store.
 *
 * **Nothing is written until everything is valid.**
 *
 * **A schema write is refused when it would leave stored values behind.** A property's values live on
 * the records, keyed by the schema id, so removing an option that records still carry, or changing a
 * property from one value type to another while records carry the old shape, would leave values that
 * no longer mean anything — the same class of question as deleting a project that still has members
 * (D56). The operations answer it the same way: they refuse with the count of affected records, so the
 * caller can clear those values first through the record operations rather than have a schema write
 * quietly rewrite somebody's data. Deleting an unused schema is ordinary and just happens.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import { defineCanonicalRecordHeader } from '../domain/canonicalIdentity.js';
import type { CanonicalRecordV2, CanonicalStoredPropertyValues } from '../domain/canonicalRecordV2.js';
import {
  defineCanonicalPropertySchema,
  type CanonicalPropertyDefinition,
  type CanonicalPropertySchemaRecord,
  type CanonicalSelectOption,
  type OpaqueSchemaOptionId,
} from '../domain/canonicalSchema.js';
import type { RecordStore, RecordStoreFileName } from '../ports/recordStore.js';
import { encodeRecordDocument, recordFileNameFor } from './jsonRecordStore.js';
import { canonicalRecordV2Codec } from './canonicalRecordCodec.js';
import type { RecordMutationCoordinator } from './recordMutation.js';

export const PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION = 1 as const;

const MAX_NAME_LENGTH = 200;
const MAX_OPTION_LABEL_LENGTH = 200;

export type PropertySchemaMutationFailureReason =
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure';

export interface PropertySchemaMutationSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION;
  readonly outcome: 'created' | 'updated' | 'option-added' | 'option-renamed' | 'option-removed' | 'deleted';
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The schema as written; `null` for a delete. */
  readonly record: CanonicalPropertySchemaRecord | null;
}

export interface PropertySchemaMutationFailure {
  readonly ok: false;
  readonly schemaVersion: typeof PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION;
  readonly reason: PropertySchemaMutationFailureReason;
  /** One bounded sentence, safe to show: never a path, a secret or a stack. */
  readonly detail: string;
  /** Present for a stale refusal, so the caller can refetch rather than guess. */
  readonly actualRevision?: string;
  /** How many records carry a value this write would have orphaned. */
  readonly affectedRecordCount?: number;
}

export type PropertySchemaMutationResult =
  | PropertySchemaMutationSuccess
  | PropertySchemaMutationFailure;

export interface PropertySchemaMutationDependencies {
  readonly store: RecordStore<CanonicalRecordV2>;
  readonly coordinator: RecordMutationCoordinator;
  readonly allocateRecordId: () => OpaqueRecordId;
  /** Options have their own identity, and the label is deliberately not part of it. */
  readonly allocateOptionId: () => OpaqueSchemaOptionId;
}

export interface CreatePropertySchemaRequest {
  readonly name: string;
  readonly definition: CanonicalPropertyDefinition;
}

/** One option at a time, because an option is what a stored value points at. */
export type SchemaOptionMutation =
  | { readonly kind: 'add'; readonly label: string }
  | { readonly kind: 'rename'; readonly optionId: OpaqueSchemaOptionId; readonly label: string }
  | { readonly kind: 'remove'; readonly optionId: OpaqueSchemaOptionId };

function refused(detail: string): PropertySchemaMutationFailure {
  return {
    ok: false,
    schemaVersion: PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION,
    reason: 'validation-refused',
    detail,
  };
}

function failed(
  reason: PropertySchemaMutationFailureReason,
  detail: string,
  actualRevision?: string,
  affectedRecordCount?: number,
): PropertySchemaMutationFailure {
  return {
    ok: false,
    schemaVersion: PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION,
    reason,
    detail,
    ...(actualRevision === undefined ? {} : { actualRevision }),
    ...(affectedRecordCount === undefined ? {} : { affectedRecordCount }),
  };
}

function nameFailure(value: unknown, subject: string): PropertySchemaMutationFailure | null {
  if (typeof value !== 'string') return refused(`a ${subject} needs a name`);
  const name = value.trim();
  if (name.length === 0) return refused(`a ${subject} needs a name`);
  if (name.length > MAX_NAME_LENGTH) return refused(`a ${subject} name may be at most ${MAX_NAME_LENGTH} characters`);
  return null;
}

/** The domain's constructor is the validator: one copy of the rules, not two. */
function definitionOrFailure(
  definition: CanonicalPropertyDefinition,
  name: string,
  id: OpaqueRecordId,
): { ok: true; record: CanonicalPropertySchemaRecord } | { ok: false; failure: PropertySchemaMutationFailure } {
  try {
    return {
      ok: true,
      record: defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id, name }),
        definition,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      failure: refused(error instanceof Error ? error.message.slice(0, 200) : 'the property definition is not valid'),
    };
  }
}

/** A schema's own values, when it has any: a stored value's shape is what a schema write may not orphan. */
function carriesValue(properties: CanonicalStoredPropertyValues | undefined, schemaId: string): boolean {
  return properties !== undefined && Object.prototype.hasOwnProperty.call(properties, schemaId);
}

function optionIdsOf(properties: CanonicalStoredPropertyValues, schemaId: string): readonly string[] {
  const value = properties[schemaId];
  if (value === undefined) return [];
  if (value.type === 'select') return [value.optionId];
  if (value.type === 'multi-select') return [...value.optionIds];
  return [];
}

async function readSchema(
  deps: PropertySchemaMutationDependencies,
  schemaId: OpaqueRecordId,
): Promise<
  | { ok: true; record: CanonicalPropertySchemaRecord; revision: string }
  | { ok: false; failure: PropertySchemaMutationFailure }
> {
  let observation;
  try {
    observation = await deps.store.read(schemaId);
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }
  if (observation === undefined || observation.kind !== 'schema') {
    return { ok: false, failure: failed('not-found', `no schema record ${schemaId}`) };
  }
  return {
    ok: true,
    record: observation.record as CanonicalPropertySchemaRecord,
    revision: observation.observedRevision,
  };
}

/**
 * The records that carry a value for a schema, and the option ids they use.
 *
 * One pass over the store, because both questions are asked of the same observation list and a write
 * that counted them twice could disagree with itself.
 */
async function valueUse(
  deps: PropertySchemaMutationDependencies,
  schemaId: string,
): Promise<{ ok: true; carrying: readonly string[]; optionUse: ReadonlyMap<string, readonly string[]> } | { ok: false; failure: PropertySchemaMutationFailure }> {
  let listed;
  try {
    listed = await deps.store.list();
  } catch {
    return { ok: false, failure: failed('storage-failure', 'the record store could not be read') };
  }

  const carrying: string[] = [];
  const optionUse = new Map<string, string[]>();
  for (const observation of listed) {
    if (observation.kind !== 'task' && observation.kind !== 'event') continue;
    const properties = (observation.record as { properties?: CanonicalStoredPropertyValues }).properties;
    if (!carriesValue(properties, schemaId)) continue;
    carrying.push(observation.id);
    for (const optionId of optionIdsOf(properties!, schemaId)) {
      optionUse.set(optionId, [...(optionUse.get(optionId) ?? []), observation.id]);
    }
  }
  return { ok: true, carrying: carrying.sort(), optionUse };
}

async function writeSchema(
  deps: PropertySchemaMutationDependencies,
  record: CanonicalPropertySchemaRecord,
  expectedRevision: string,
  outcome: PropertySchemaMutationSuccess['outcome'],
): Promise<PropertySchemaMutationResult> {
  let text: string;
  try {
    text = encodeRecordDocument(record, canonicalRecordV2Codec);
  } catch {
    return refused('the schema record did not validate');
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'update',
      fileName: recordFileNameFor(record.id),
      text,
      expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'stale':
        return failed('stale-revision', 'another writer changed this schema first', result.actualRevision);
      case 'missing':
        return failed('not-found', 'the schema record is not in the store');
      case 'recovery-required':
        return failed('recovery-required', 'the store needs recovery before it accepts writes');
      case 'invalid-record-file-name':
        return refused('the record id cannot name a record file');
      default:
        return failed('storage-failure', 'the record store rejected the write');
    }
  }

  return {
    ok: true,
    schemaVersion: PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION,
    outcome,
    recordId: record.id,
    revision: result.revision,
    record,
  };
}

export async function createPropertySchema(
  deps: PropertySchemaMutationDependencies,
  request: CreatePropertySchemaRequest,
): Promise<PropertySchemaMutationResult> {
  const naming = nameFailure(request.name, 'property');
  if (naming !== null) return naming;

  const id = deps.allocateRecordId();
  const built = definitionOrFailure(request.definition, request.name.trim(), id);
  if (!built.ok) return built.failure;

  let result;
  try {
    result = await deps.store.createIfAbsent(built.record);
  } catch {
    return failed('storage-failure', 'the record store rejected the write');
  }
  if (!result.ok) {
    return result.reason === 'already-exists'
      ? failed('semantic-conflict', 'a record with that id already exists')
      : failed('storage-failure', 'the record store rejected the write', result.actualRevision);
  }

  return {
    ok: true,
    schemaVersion: PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION,
    outcome: 'created',
    recordId: built.record.id,
    revision: result.revision,
    record: built.record,
  };
}

/**
 * Change a schema's name, its definition, or both.
 *
 * A definition whose type differs from the stored one is refused while any record carries a value for
 * the property: every stored value is shaped by the type that wrote it, so a type change is a data
 * migration, not an edit. Renaming needs no such rule, which is why an option's label and a schema's
 * name are not identity.
 */
export async function updatePropertySchema(
  deps: PropertySchemaMutationDependencies,
  input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly name?: string;
    readonly definition?: CanonicalPropertyDefinition;
  },
): Promise<PropertySchemaMutationResult> {
  if (input.name === undefined && input.definition === undefined) {
    return refused('an update with no field to change is not an update');
  }
  if (input.name !== undefined) {
    const naming = nameFailure(input.name, 'property');
    if (naming !== null) return naming;
  }

  const current = await readSchema(deps, input.schemaId);
  if (!current.ok) return current.failure;
  if (current.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this schema first', current.revision);
  }

  if (input.definition !== undefined && input.definition.type !== current.record.definition.type) {
    const use = await valueUse(deps, input.schemaId);
    if (!use.ok) return use.failure;
    if (use.carrying.length > 0) {
      return failed(
        'semantic-conflict',
        `the property holds a value on ${use.carrying.length} record(s); changing what kind of value it holds would orphan them`,
        undefined,
        use.carrying.length,
      );
    }
  }

  const built = definitionOrFailure(
    input.definition ?? current.record.definition,
    input.name === undefined ? current.record.name : input.name.trim(),
    current.record.id,
  );
  if (!built.ok) return built.failure;

  return await writeSchema(deps, built.record, input.expectedRevision, 'updated');
}

/**
 * Edit a field definition without changing what kind of value the property holds.
 *
 * This is the narrow verb the checklist's formula/rollup/relation row names: an expression, an
 * aggregation, a set of targets or a list of options may change here, and the type may not — not
 * because the type is special but because a stored value's shape is, and a caller that wants to change
 * it is asking for the migration `updatePropertySchema` refuses while values exist.
 */
export async function updateSchemaField(
  deps: PropertySchemaMutationDependencies,
  input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly definition: CanonicalPropertyDefinition;
  },
): Promise<PropertySchemaMutationResult> {
  const current = await readSchema(deps, input.schemaId);
  if (!current.ok) return current.failure;
  if (current.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this schema first', current.revision);
  }
  if (input.definition.type !== current.record.definition.type) {
    return refused(
      `a field edit may not change ${current.record.definition.type} into ${input.definition.type}; that is a value migration`,
    );
  }

  const built = definitionOrFailure(input.definition, current.record.name, current.record.id);
  if (!built.ok) return built.failure;

  return await writeSchema(deps, built.record, input.expectedRevision, 'updated');
}

/**
 * Add, rename or remove one option of a select or multi-select property.
 *
 * A removal is refused while records still point at that option, with the count, for the same reason
 * a type change is: the option id is what a stored value holds, so removing it would leave values that
 * name nothing. Renaming is always safe, and that asymmetry is the point of option identity.
 */
export async function updateSchemaOption(
  deps: PropertySchemaMutationDependencies,
  input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly option: SchemaOptionMutation;
  },
): Promise<PropertySchemaMutationResult> {
  const current = await readSchema(deps, input.schemaId);
  if (!current.ok) return current.failure;
  if (current.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this schema first', current.revision);
  }

  const definition = current.record.definition;
  if (definition.type !== 'select' && definition.type !== 'multi-select') {
    return refused('only a select or multi-select property has options');
  }

  const options: readonly CanonicalSelectOption[] = definition.options;
  const option = input.option;
  const outcome: PropertySchemaMutationSuccess['outcome'] = option.kind === 'add'
    ? 'option-added'
    : option.kind === 'rename' ? 'option-renamed' : 'option-removed';

  let nextOptions: CanonicalSelectOption[];
  if (option.kind === 'add') {
    const labelFailure = nameFailure(option.label, 'option');
    if (labelFailure !== null) return labelFailure;
    const label = option.label.trim();
    if (label.length > MAX_OPTION_LABEL_LENGTH) return refused(`an option label may be at most ${MAX_OPTION_LABEL_LENGTH} characters`);
    if (options.some((existing) => existing.label === label)) {
      return refused(`this property already offers an option labelled ${label}`);
    }
    nextOptions = [...options, { id: deps.allocateOptionId(), label }];
  } else if (option.kind === 'rename') {
    const labelFailure = nameFailure(option.label, 'option');
    if (labelFailure !== null) return labelFailure;
    const label = option.label.trim();
    if (label.length > MAX_OPTION_LABEL_LENGTH) return refused(`an option label may be at most ${MAX_OPTION_LABEL_LENGTH} characters`);
    const targetId = option.optionId;
    const found = options.find((existing) => existing.id === targetId);
    if (found === undefined) return failed('not-found', 'this property has no such option');
    if (options.some((existing) => existing.label === label && existing.id !== targetId)) {
      return refused(`this property already offers an option labelled ${label}`);
    }
    nextOptions = options.map((existing) => (existing.id === targetId ? { id: existing.id, label } : { id: existing.id, label: existing.label }));
  } else {
    const targetId = option.optionId;
    const found = options.find((existing) => existing.id === targetId);
    if (found === undefined) return failed('not-found', 'this property has no such option');
    const use = await valueUse(deps, input.schemaId);
    if (!use.ok) return use.failure;
    const holders = use.optionUse.get(targetId) ?? [];
    if (holders.length > 0) {
      return failed(
        'semantic-conflict',
        `${holders.length} record(s) still use the option ${found.label}; clear them before removing it`,
        undefined,
        holders.length,
      );
    }
    nextOptions = options.filter((existing) => existing.id !== targetId);
  }

  const built = definitionOrFailure(
    definition.type === 'select' ? { type: 'select', options: nextOptions } : { type: 'multi-select', options: nextOptions },
    current.record.name,
    current.record.id,
  );
  if (!built.ok) return built.failure;

  return await writeSchema(deps, built.record, input.expectedRevision, outcome);
}

/**
 * Delete a schema.
 *
 * Refused while records carry a value for it, with the count: the values live on those records and
 * would be left naming a schema nothing defines. An unused schema is deleted outright.
 */
export async function deletePropertySchema(
  deps: PropertySchemaMutationDependencies,
  input: { readonly schemaId: OpaqueRecordId; readonly expectedRevision: string },
): Promise<PropertySchemaMutationResult> {
  const current = await readSchema(deps, input.schemaId);
  if (!current.ok) return current.failure;
  if (current.revision !== input.expectedRevision) {
    return failed('stale-revision', 'another writer changed this schema first', current.revision);
  }

  const use = await valueUse(deps, input.schemaId);
  if (!use.ok) return use.failure;
  if (use.carrying.length > 0) {
    return failed(
      'semantic-conflict',
      `${use.carrying.length} record(s) still carry a value for this property; clear them before deleting it`,
      undefined,
      use.carrying.length,
    );
  }

  let result;
  try {
    result = await deps.coordinator.execute({
      kind: 'delete',
      fileName: recordFileNameFor(input.schemaId),
      expectedRevision: input.expectedRevision,
    });
  } catch {
    return failed('storage-failure', 'the write could not be attempted');
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'stale':
        return failed('stale-revision', 'another writer changed this schema first', result.actualRevision);
      case 'missing':
        return failed('not-found', 'the schema record is not in the store');
      case 'recovery-required':
        return failed('recovery-required', 'the store needs recovery before it accepts writes');
      case 'invalid-record-file-name':
        return refused('the record id cannot name a record file');
      default:
        return failed('storage-failure', 'the record store rejected the write');
    }
  }

  return {
    ok: true,
    schemaVersion: PROPERTY_SCHEMA_MUTATION_SCHEMA_VERSION,
    outcome: 'deleted',
    recordId: input.schemaId,
    revision: result.revision,
    record: null,
  };
}

/** The record file a schema lives in, for a caller reasoning about the store's files. */
export function propertySchemaRecordFileName(schemaId: OpaqueRecordId): RecordStoreFileName {
  return recordFileNameFor(schemaId);
}
