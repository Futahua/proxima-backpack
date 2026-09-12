/**
 * What a schema editor would render, and what a form's Save would submit.
 *
 * The agenda's three schema rows have carried the same gap since the matrix was built: the record layer writes
 * a schema, the agent wire reaches those writes, and **no surface has ever offered them** - and
 * `tests/actionCoverageAudit.test.ts` asserted that absence row by row, so the gap could not quietly become a
 * claim. This module is the surface's missing half, and its shape is the one every other editor here has:
 *
 * - **A projection renders, a form submits.** `propertySchemaEditor` turns the canonical schema records into
 *   rows a surface draws; `schemaCreateSubmission` and its siblings turn what a form holds into the submission
 *   `submitPropertySchemaAction` already parses - the same entry the agent wire uses, so the two callers share
 *   one implementation and one set of refusal sentences rather than two that must be kept in step.
 * - **It reads the canonical records, not the projection.** That is a deliberate choice and the reason is a
 *   real mismatch: `ProximaState.taskSchema` is the *legacy* shape, whose options carry a `name` and a `color`
 *   and whose records carry no observed revision, while every verb here identifies an option by an opaque id and
 *   a label and writes against a revision. Building the editor on the projection would mean translating between
 *   two vocabularies for no benefit and inventing ids the record layer is the one that allocates.
 * - **This module validates nothing.** Whether a name is acceptable, whether a definition is real and whether a
 *   re-type would orphan stored values are the record layer's answers, and they arrive as its refusals with the
 *   field at fault. What this layer owns is the *translation*: a typed definition is not a form field, and this
 *   is the one place that translation lives, where a test can drive it.
 */
import type { CanonicalPropertyDefinition, CanonicalPropertySchemaRecord } from '../domain/canonicalSchema.js';
import { PROPERTY_SCHEMA_ACTION_TYPES } from './propertySchemaActions.js';

export const PROPERTY_SCHEMA_EDITOR_SCHEMA_VERSION = 1 as const;

/**
 * The property types a reader may choose, in the order the surface offers them.
 *
 * The order is deliberate rather than alphabetical: the simple types come first because they are the ones a
 * reader reaches for, and the three that need another record to point at come after them - a formula or a
 * rollup cannot sensibly be the first property someone declares, because it would have nothing to reference.
 */
export const PROPERTY_SCHEMA_EDITOR_TYPES: readonly string[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi-select',
  'relation',
  'rollup',
  'formula',
];

/** The types whose definition carries labels, and so the ones an options list appears for. */
export const PROPERTY_SCHEMA_OPTION_TYPES: readonly string[] = ['select', 'multi-select'];

/**
 * The types this editor can create.
 *
 * Not all of them, and the limit is a fact about forms rather than about the record layer: a relation names
 * the record kinds it may point at, a rollup names a relation schema *and* a target schema, and a formula
 * carries an expression - each needs a chooser this editor does not have, and a create that invented a target
 * would be declaring a property that references nothing.
 */
export const PROPERTY_SCHEMA_CREATABLE_TYPES: readonly string[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi-select',
];

export interface PropertySchemaEditorOption {
  readonly optionId: string;
  readonly label: string;
}

export interface PropertySchemaEditorRow {
  readonly schemaId: string;
  readonly name: string;
  /** The declared type, as a reader would say it. */
  readonly type: string;
  /**
   * The revision a write against this row must carry.
   *
   * This is the field the projection could not supply and the reason the editor reads the records: without it
   * a rename would be a write against a guessed revision, which is how one caller's read overwrites another's.
   */
  readonly revision: string;
  /** The options this schema declares, in declaration order. Empty for a type that has none. */
  readonly options: readonly PropertySchemaEditorOption[];
  /** The definition's own sentence, for the types whose meaning is not in their name. */
  readonly detail: string | null;
  /**
   * Whether this row's type may be changed here.
   *
   * False for the types that point at another record, and false for a select whose options a stored value may
   * already use - which is not a fact this projection can know. The record layer refuses such a change with the
   * count of values it would orphan, and a surface that offered the control anyway would be promising something
   * it cannot deliver.
   */
  readonly typeEditable: boolean;
}

export interface PropertySchemaEditorProjection {
  readonly schemaVersion: typeof PROPERTY_SCHEMA_EDITOR_SCHEMA_VERSION;
  /** One row per declared schema, in the order the caller supplies them. */
  readonly rows: readonly PropertySchemaEditorRow[];
  /** The types the create form offers, and the types whose definition carries options. */
  readonly creatableTypes: readonly string[];
  readonly optionTypes: readonly string[];
  readonly declaredCount: number;
}

/** A definition's own sentence, when its meaning is not carried by its type name alone. */
function detailOf(definition: CanonicalPropertyDefinition): string | null {
  switch (definition.type) {
    case 'formula':
      return definition.expression;
    case 'rollup':
      return `${definition.aggregation} of a property on the related record`;
    case 'relation':
      return `may point at ${definition.targetKinds.join(', ')}`;
    default:
      return null;
  }
}

/**
 * Project the declared schemas for an editor.
 *
 * @param schemas - the canonical schema records, each with the revision it was observed at. The caller is what
 *   reads them, because where records live is not this layer's business - and `PropertySchemaWriteOperations`
 *   is not enough on its own, since neither it nor the projection carries a revision.
 * @returns the rows and the type lists the surface draws.
 */
export function propertySchemaEditor(
  schemas: readonly { readonly record: CanonicalPropertySchemaRecord; readonly revision: string }[],
): PropertySchemaEditorProjection {
  const rows: PropertySchemaEditorRow[] = schemas.map(({ record, revision }) => ({
    schemaId: record.id,
    name: record.name,
    type: record.definition.type,
    revision,
    options: record.definition.type === 'select' || record.definition.type === 'multi-select'
      ? record.definition.options.map((option) => ({ optionId: option.id, label: option.label }))
      : [],
    detail: detailOf(record.definition),
    typeEditable: PROPERTY_SCHEMA_CREATABLE_TYPES.includes(record.definition.type),
  }));

  return {
    schemaVersion: PROPERTY_SCHEMA_EDITOR_SCHEMA_VERSION,
    rows,
    creatableTypes: [...PROPERTY_SCHEMA_CREATABLE_TYPES],
    optionTypes: [...PROPERTY_SCHEMA_OPTION_TYPES],
    declaredCount: rows.length,
  };
}

/** What the create form holds. */
export interface PropertySchemaCreateForm {
  readonly name: string;
  readonly type: string;
  /** Labels, comma-separated, for the types that carry them. Ignored for the types that do not. */
  readonly options: string;
}

/** What a row's rename form holds. */
export interface PropertySchemaRenameForm {
  readonly schemaId: string;
  readonly revision: string;
  readonly name: string;
}

/** What a row's add-option form holds. */
export interface PropertySchemaAddOptionForm {
  readonly schemaId: string;
  readonly revision: string;
  readonly label: string;
}

/**
 * The labels a reader typed, in the order they typed them.
 *
 * Text is how a form carries a list, so this is where that translation happens and nowhere else. Blank entries
 * are dropped rather than refused: a trailing comma is a typo, not a request for an unnamed option, and the
 * record layer would refuse the empty label with a sentence about labels rather than about the comma the reader
 * actually left behind.
 *
 * @param text - what the form holds.
 * @returns the labels, trimmed, in order, with the blanks removed.
 */
export function schemaOptionLabelsFrom(text: string): readonly string[] {
  return text
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

/**
 * The definition a create form describes.
 *
 * Only the types the form offers are built here, and a type it does not offer is `null` rather than a guess.
 *
 * **A select is created empty and filled by the option verb.** That is not a shortcut: a canonical option
 * carries an opaque id, the record layer is what allocates one, and the `option` verb is the operation that
 * does it one label at a time. Passing labels here would mean this form inventing ids the record layer owns,
 * and a form that minted identity would be the one thing every other module in this tree refuses to do.
 *
 * @param type - the type the reader chose.
 * @returns the definition, or null for a type this form cannot create.
 */
export function schemaDefinitionFor(type: string): CanonicalPropertyDefinition | null {
  switch (type) {
    case 'text':
      return { type: 'text' };
    case 'number':
      return { type: 'number' };
    case 'date':
      return { type: 'date' };
    case 'checkbox':
      return { type: 'checkbox' };
    case 'select':
      return { type: 'select', options: [] };
    case 'multi-select':
      return { type: 'multi-select', options: [] };
    default:
      return null;
  }
}

/**
 * The submission a create form would send.
 *
 * A select is created **empty**: a canonical option carries an opaque id, the record layer is what allocates
 * one, and the `option` verb is the operation that does it one label at a time. That is why the labels are
 * asked for separately - see `schemaOptionLabelsFrom` and `schemaOptionSubmissionsFor` - rather than travelling
 * with this submission. Passing them here would mean this form inventing ids the record layer owns, and a form
 * that minted identity would be the one thing every other module in this tree refuses to do.
 *
 * Returns null for a type this form cannot create, so a surface answers by not offering the type rather than by
 * failing at Save.
 */
export function schemaCreateSubmission(form: PropertySchemaCreateForm): unknown | null {
  const definition = schemaDefinitionFor(form.type);
  if (definition === null) return null;

  return {
    type: PROPERTY_SCHEMA_ACTION_TYPES.create,
    name: form.name,
    definition,
  };
}

/**
 * The option submissions a create needs once its schema exists.
 *
 * The ids do not exist until the create lands, so a caller runs `schemaCreateSubmission` first, reads the new
 * record's id and revision from the result, and then asks for these. Kept here so that sequencing is one
 * function rather than a loop each caller writes for itself.
 */
export function schemaCreateOptionSubmissions(
  form: PropertySchemaCreateForm,
  schemaId: string,
  revision: string,
): readonly unknown[] {
  if (!PROPERTY_SCHEMA_OPTION_TYPES.includes(form.type)) return [];
  return schemaOptionSubmissionsFor(schemaId, revision, schemaOptionLabelsFrom(form.options));
}

/** The submissions that add one label each, at a schema's revision. */
export function schemaOptionSubmissionsFor(
  schemaId: string,
  revision: string,
  labels: readonly string[],
): readonly unknown[] {
  return labels.map((label) => ({
    type: PROPERTY_SCHEMA_ACTION_TYPES.option,
    schemaId,
    expectedRevision: revision,
    option: { kind: 'add', label },
  }));
}

/** The submission a row's rename form would send: a name, at the revision the row was drawn from. */
export function schemaRenameSubmission(form: PropertySchemaRenameForm): unknown {
  return {
    type: PROPERTY_SCHEMA_ACTION_TYPES.update,
    schemaId: form.schemaId,
    expectedRevision: form.revision,
    name: form.name,
  };
}

/**
 * The submission a row's add-option form would send.
 *
 * One label at a time, which is what the record layer takes: an option is what a stored value points at, so
 * adding two at once would be two mutations wearing one submission's clothes. A blank label is passed through
 * rather than refused here - the record layer's sentence about labels is the one a reader should hear.
 */
export function schemaAddOptionSubmission(form: PropertySchemaAddOptionForm): unknown {
  return {
    type: PROPERTY_SCHEMA_ACTION_TYPES.option,
    schemaId: form.schemaId,
    expectedRevision: form.revision,
    option: { kind: 'add', label: form.label },
  };
}

/** The submission a row's Delete would send. */
export function schemaDeleteSubmission(schemaId: string, revision: string): unknown {
  return {
    type: PROPERTY_SCHEMA_ACTION_TYPES.delete,
    schemaId,
    expectedRevision: revision,
  };
}
