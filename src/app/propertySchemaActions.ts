/**
 * The property-schema semantic actions: the verbs that change what a property *is*.
 *
 * The record layer already writes a schema correctly - create, update, delete, one option at a time, and a
 * field edit that may not change the type a stored value was written under - and it refuses in the action
 * taxonomy's own vocabulary. What it never had was a *boundary*: a caller handed the operations a typed
 * request, the module validated it, and nothing accepted `unknown` and answered with a sentence. That is
 * the gap the contract matrix records on the three schema rows, and this module is the layer that closes it
 * for the reasons spelled out in D74:
 *
 * - **A sibling entry, not a `ProximaAction`.** The protocol's registry carries no schema verb, and adding
 *   one would put a record mutation behind `dispatch` - the containment rule every audit asserts. A schema
 *   write is reachable the way template execution and the agent write path are: through a named entry.
 * - **The boundary validates the outer shape only.** Whether a name is acceptable, whether a definition is
 *   a real property definition and whether an option rename is legal are the record layer's answers and come
 *   back as its refusals, so there is one copy of each rule rather than two.
 * - **One request id, minted before the submission is parsed**, so a malformed submission is journalled
 *   with the id its own refusal names. No caller-supplied id is read, and `requestId` is not among the ids
 *   a submission may name.
 * - **No refresh is taken.** The Backlog reads the declared schema on every render
 *   (`tests/schemaReprojection.test.ts`), so a schema write leaves no stale surface behind: what it owes is
 *   the record, its revision and the event.
 */
import type { OpaqueRecordId } from '../domain/canonicalIdentity.js';
import type { CanonicalPropertyDefinition, OpaqueSchemaOptionId } from '../domain/canonicalSchema.js';
import type { IdGenerator } from '../domain/clock.js';
import {
  createPropertySchema,
  deletePropertySchema,
  updatePropertySchema,
  updateSchemaField,
  updateSchemaOption,
  type CreatePropertySchemaRequest,
  type PropertySchemaMutationFailureReason,
  type PropertySchemaMutationResult,
  type PropertySchemaMutationSuccess,
  type SchemaOptionMutation,
} from './propertySchemaMutations.js';
import { mintSemanticRequestId, type SemanticAuditSink, type SemanticOutcome } from './semanticAudit.js';

export const PROPERTY_SCHEMA_ACTION_SCHEMA_VERSION = 1 as const;

/** The five verbs, each with the semantic action type its event is journalled under. */
export type PropertySchemaVerb = 'create' | 'update' | 'delete' | 'option' | 'field';

export const PROPERTY_SCHEMA_ACTION_TYPES: Readonly<Record<PropertySchemaVerb, string>> = {
  create: 'property.schema.create',
  update: 'property.schema.update',
  delete: 'property.schema.delete',
  option: 'property.schema.option.change',
  field: 'property.schema.field.change',
};

const VERB_FOR_TYPE = new Map<string, PropertySchemaVerb>(
  (Object.entries(PROPERTY_SCHEMA_ACTION_TYPES) as readonly (readonly [PropertySchemaVerb, string])[])
    .map(([verb, type]) => [type, verb]),
);

/**
 * The record writes this layer submits to.
 *
 * Structural and narrow, exactly as the other action families take them: the layer knows which verb means
 * what, not where records live.
 */
export interface PropertySchemaWriteOperations {
  createPropertySchema(request: CreatePropertySchemaRequest): Promise<PropertySchemaMutationResult>;
  updatePropertySchema(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly name?: string;
    readonly definition?: CanonicalPropertyDefinition;
  }): Promise<PropertySchemaMutationResult>;
  updateSchemaField(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly definition: CanonicalPropertyDefinition;
  }): Promise<PropertySchemaMutationResult>;
  updateSchemaOption(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
    readonly option: SchemaOptionMutation;
  }): Promise<PropertySchemaMutationResult>;
  deletePropertySchema(input: {
    readonly schemaId: OpaqueRecordId;
    readonly expectedRevision: string;
  }): Promise<PropertySchemaMutationResult>;
}

export interface PropertySchemaActionDependencies {
  /** Resolve the sanctioned write path; null when this run may not write records. */
  readonly writes: () => Promise<PropertySchemaWriteOperations | null>;
  /** Why there is no write path, in words a reader can act on. */
  readonly unavailableReason: () => string | null;
  /** Mints this run's semantic request id. Injected, like every other identity in this repository. */
  readonly ids: IdGenerator;
  /** Where the run's one terminal audit event goes. */
  readonly audit: SemanticAuditSink;
}

export type PropertySchemaActionFailureReason =
  | 'malformed-submission'
  | 'unsupported-verb'
  | 'writes-unavailable'
  | PropertySchemaMutationFailureReason;

/** The success branch keeps the record layer's own outcome, so a caller cannot confuse the two vocabularies. */
export interface PropertySchemaActionSuccess {
  readonly ok: true;
  readonly schemaVersion: typeof PROPERTY_SCHEMA_ACTION_SCHEMA_VERSION;
  readonly verb: PropertySchemaVerb;
  readonly actionType: string;
  readonly outcome: PropertySchemaMutationSuccess['outcome'];
  /** Present on every result: a schema write is correlatable with the event it left behind. */
  readonly requestId: string;
  readonly recordId: OpaqueRecordId;
  readonly revision: string;
  /** The ids the run touched: the schema record, and nothing else. */
  readonly entityIds: readonly string[];
}

export interface PropertySchemaActionFailure {
  readonly ok: false;
  readonly schemaVersion: typeof PROPERTY_SCHEMA_ACTION_SCHEMA_VERSION;
  /** The verb the submission named, or `null` when it named none this layer runs. */
  readonly verb: PropertySchemaVerb | null;
  readonly actionType: string;
  readonly reason: PropertySchemaActionFailureReason;
  readonly detail: string;
  readonly requestId: string;
  /** The known targets on a refusal, and none for a create, which has no target until it lands. */
  readonly entityIds: readonly string[];
  /** Present for a stale refusal, so the caller can refetch rather than guess. */
  readonly actualRevision?: string;
  /** Present when the refusal is about stored values a write would have orphaned. */
  readonly affectedRecordCount?: number;
}

export type PropertySchemaActionOutcome = PropertySchemaActionSuccess | PropertySchemaActionFailure;

export interface ParsedPropertySchemaSubmission {
  readonly ok: true;
  readonly verb: PropertySchemaVerb;
  readonly actionType: string;
  readonly schemaId: string | null;
  readonly expectedRevision: string | null;
  readonly request: () => Promise<PropertySchemaMutationResult>;
}

export interface RejectedPropertySchemaSubmission {
  readonly ok: false;
  readonly reason: 'malformed-submission' | 'unsupported-verb';
  readonly detail: string;
  readonly actionType: string;
  readonly verb: PropertySchemaVerb | null;
  readonly schemaId: string | null;
}

function rejected(
  reason: 'malformed-submission' | 'unsupported-verb',
  detail: string,
  actionType: string,
  verb: PropertySchemaVerb | null,
  schemaId: string | null,
): RejectedPropertySchemaSubmission {
  return { ok: false, reason, detail, actionType, verb, schemaId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A definition is an object with a named type; whether the type is real, and complete, is the domain constructor's answer. */
function looksLikeDefinition(value: unknown): value is CanonicalPropertyDefinition {
  return isRecord(value) && typeof value.type === 'string' && value.type !== '';
}

function optionMutation(value: unknown): SchemaOptionMutation | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'add') {
    return typeof value.label === 'string' ? { kind: 'add', label: value.label } : null;
  }
  if (value.kind === 'rename') {
    return typeof value.label === 'string' && typeof value.optionId === 'string' && value.optionId !== ''
      ? { kind: 'rename', optionId: value.optionId as OpaqueSchemaOptionId, label: value.label }
      : null;
  }
  if (value.kind === 'remove') {
    return typeof value.optionId === 'string' && value.optionId !== ''
      ? { kind: 'remove', optionId: value.optionId as OpaqueSchemaOptionId }
      : null;
  }
  return null;
}

/**
 * Validate the outer wire shape and bind the submission to the record operation it names.
 *
 * The binding is a closure rather than a data shape on purpose: what a create request *is* stays the record
 * layer's type, and this layer never re-states it.
 */
export function parsePropertySchemaSubmission(
  operations: PropertySchemaWriteOperations,
  input: unknown,
): ParsedPropertySchemaSubmission | RejectedPropertySchemaSubmission {
  if (!isRecord(input)) {
    return rejected('malformed-submission', 'a schema submission is an object', 'unknown', null, null);
  }
  const rawType = input.type;
  if (typeof rawType !== 'string' || rawType === '') {
    return rejected('malformed-submission', 'the submission needs a type', 'unknown', null, null);
  }

  const verb = VERB_FOR_TYPE.get(rawType);
  if (verb === undefined) {
    return rejected(
      'unsupported-verb',
      `${rawType} is not a property-schema verb: this entry runs ${Object.values(PROPERTY_SCHEMA_ACTION_TYPES).join(', ')}`,
      rawType,
      null,
      typeof input.schemaId === 'string' ? input.schemaId : null,
    );
  }

  const schemaId = typeof input.schemaId === 'string' && input.schemaId !== '' ? input.schemaId : null;
  const expectedRevision = typeof input.expectedRevision === 'string' && input.expectedRevision !== ''
    ? input.expectedRevision
    : null;
  const fail = (detail: string): RejectedPropertySchemaSubmission =>
    rejected('malformed-submission', detail, rawType, verb, schemaId);

  if (verb === 'create') {
    if (typeof input.name !== 'string') return fail('a create needs a name');
    if (!looksLikeDefinition(input.definition)) return fail('a create needs a property definition');
    const name = input.name;
    const definition = input.definition;
    return {
      ok: true,
      verb,
      actionType: rawType,
      schemaId: null,
      expectedRevision: null,
      request: async () => await operations.createPropertySchema({ name, definition }),
    };
  }

  if (schemaId === null) return fail('the submission needs a schemaId');
  if (expectedRevision === null) {
    return fail('the submission needs the revision it read the schema at, so a lost race is refused rather than merged');
  }
  const id = schemaId as OpaqueRecordId;
  const revision = expectedRevision;

  if (verb === 'delete') {
    return { ok: true, verb, actionType: rawType, schemaId, expectedRevision, request: async () => await operations.deletePropertySchema({ schemaId: id, expectedRevision: revision }) };
  }

  if (verb === 'update') {
    if (input.name === undefined && input.definition === undefined) {
      return fail('an update with no field to change is not an update');
    }
    if (input.name !== undefined && typeof input.name !== 'string') return fail('a name, when given, is a string');
    if (input.definition !== undefined && !looksLikeDefinition(input.definition)) return fail('a definition, when given, is a property definition');
    const name = input.name as string | undefined;
    const definition = input.definition as CanonicalPropertyDefinition | undefined;
    return {
      ok: true,
      verb,
      actionType: rawType,
      schemaId,
      expectedRevision,
      request: async () => await operations.updatePropertySchema({
        schemaId: id,
        expectedRevision: revision,
        ...(name === undefined ? {} : { name }),
        ...(definition === undefined ? {} : { definition }),
      }),
    };
  }

  if (verb === 'field') {
    if (!looksLikeDefinition(input.definition)) return fail('a field edit needs a property definition');
    const definition = input.definition;
    return { ok: true, verb, actionType: rawType, schemaId, expectedRevision, request: async () => await operations.updateSchemaField({ schemaId: id, expectedRevision: revision, definition }) };
  }

  const option = optionMutation(input.option);
  if (option === null) return fail('an option change is add, rename or remove, with the label or id it needs');
  return { ok: true, verb, actionType: rawType, schemaId, expectedRevision, request: async () => await operations.updateSchemaOption({ schemaId: id, expectedRevision: revision, option }) };
}

function refusal(
  verb: PropertySchemaVerb | null,
  actionType: string,
  reason: PropertySchemaActionFailureReason,
  detail: string,
  requestId: string,
  entityIds: readonly string[],
  extra: { readonly actualRevision?: string; readonly affectedRecordCount?: number } = {},
): PropertySchemaActionFailure {
  return {
    ok: false,
    schemaVersion: PROPERTY_SCHEMA_ACTION_SCHEMA_VERSION,
    verb,
    actionType,
    reason,
    detail,
    requestId,
    entityIds: [...entityIds],
    ...(extra.actualRevision === undefined ? {} : { actualRevision: extra.actualRevision }),
    ...(extra.affectedRecordCount === undefined ? {} : { affectedRecordCount: extra.affectedRecordCount }),
  };
}

/**
 * Submit one schema verb.
 *
 * The request id is minted before the submission is parsed, which is the same convention `dispatch` and the
 * agent write path follow: a submission this layer cannot read is still correlatable with the refusal it got.
 */
export async function submitPropertySchemaAction(
  deps: PropertySchemaActionDependencies,
  input: unknown,
): Promise<PropertySchemaActionOutcome> {
  const requestId = mintSemanticRequestId(deps.ids);
  const audit = (actionType: string, outcome: SemanticOutcome, entityIds: readonly string[], errorCode?: string): void => {
    deps.audit.append({
      requestId,
      actionType,
      outcome,
      entityIds: [...entityIds],
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  const operations = await deps.writes();
  if (operations === null) {
    const reason = deps.unavailableReason() ?? 'writes-unavailable';
    audit('property.schema', 'rejected', [], 'writes-unavailable');
    return refusal(null, 'property.schema', 'writes-unavailable', reason, requestId, []);
  }

  const parsed = parsePropertySchemaSubmission(operations, input);
  if (!parsed.ok) {
    audit(parsed.actionType, 'rejected', parsed.schemaId === null ? [] : [parsed.schemaId], parsed.reason === 'unsupported-verb' ? 'action-not-available' : 'validation-refused');
    return refusal(parsed.verb, parsed.actionType, parsed.reason, parsed.detail, requestId, parsed.schemaId === null ? [] : [parsed.schemaId]);
  }

  const written: PropertySchemaMutationResult = await parsed.request();
  // A create names its target only once it has one; every other verb knew its schema before it wrote.
  const target = written.ok ? written.recordId : parsed.schemaId;
  const entityIds = target === null ? [] : [target];

  if (!written.ok) {
    audit(parsed.actionType, 'rejected', entityIds, written.reason);
    return refusal(parsed.verb, parsed.actionType, written.reason, written.detail, requestId, entityIds, {
      ...(written.actualRevision === undefined ? {} : { actualRevision: written.actualRevision }),
      ...(written.affectedRecordCount === undefined ? {} : { affectedRecordCount: written.affectedRecordCount }),
    });
  }

  audit(parsed.actionType, 'accepted', entityIds);
  return {
    ok: true,
    schemaVersion: PROPERTY_SCHEMA_ACTION_SCHEMA_VERSION,
    verb: parsed.verb,
    actionType: parsed.actionType,
    outcome: written.outcome,
    requestId,
    recordId: written.recordId,
    revision: written.revision,
    entityIds,
  };
}
