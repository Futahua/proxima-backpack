/**
 * Custom-property edits: from what a form holds back to what the record stores.
 *
 * This is the mapping Stage 9 deliberately deferred. A property value reaches the editor through the
 * *compatibility* projection — a select's option id becomes its label, a relation becomes a list of
 * record ids, a multi-select becomes a list of labels — so writing one back needs the canonical
 * schema to reverse it, and the schema is what says which reversal is even allowed.
 *
 * Four rules, and each exists because the alternative loses data silently:
 *
 * - **A derived value is never written.** A rollup or a formula is computed from other records; the
 *   schema says so, and setting one would either be overwritten on the next read or, worse, be
 *   believed. It is refused by name.
 * - **An option is matched by id first, then by label.** The projection wrote labels, so a label is
 *   what a form usually holds — but a value that is already an option id is still that option, and
 *   treating it as an unmatched label would clear a value that was never wrong.
 * - **A blank is a clear.** Emptying a text, number or date field means "no value", which the
 *   canonical record says with the property absent. A checkbox is different: false is a value, and
 *   the form has no way to say "unset" for one.
 * - **A relation is ids, never names** (A6), so a name typed into a relation field is refused rather
 *   than resolved — a relation that guessed would point at a record nobody chose.
 */
import { parseOpaqueRecordId, type OpaqueRecordId } from '../domain/canonicalIdentity.js';
import { parseOpaqueSchemaOptionId, type OpaqueSchemaOptionId } from '../domain/canonicalSchema.js';
import type { CanonicalStoredPropertyValue } from '../domain/canonicalRecordV2.js';
import type { PropertySchema } from '../domain/types.js';

export const PROPERTY_MUTATION_PLAN_VERSION = 1 as const;

export type PropertyPlanFailureReason = 'unknown-schema' | 'unsupported-field' | 'validation-refused';

export type PropertyMutationPlan =
  | {
      readonly ok: true;
      readonly schemaVersion: typeof PROPERTY_MUTATION_PLAN_VERSION;
      /** Null is a clear: the record drops the key rather than storing an empty value. */
      readonly value: CanonicalStoredPropertyValue | null;
    }
  | {
      readonly ok: false;
      readonly schemaVersion: typeof PROPERTY_MUTATION_PLAN_VERSION;
      readonly reason: PropertyPlanFailureReason;
      readonly detail: string;
    };

/** One property field as the form holds it: the text a control shows, plus its flags. */
export interface PropertyFieldValue {
  readonly value: string;
  readonly checked: boolean;
  readonly selected: readonly string[];
}

function refused(reason: PropertyPlanFailureReason, detail: string): PropertyMutationPlan {
  return { ok: false, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, reason, detail };
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/** The ids a relation field holds: comma or whitespace separated, because that is how it is shown. */
function relationIds(value: string): { ok: true; ids: OpaqueRecordId[] } | { ok: false; bad: string } {
  const parts = value.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part.length > 0);
  const ids: OpaqueRecordId[] = [];
  for (const part of parts) {
    try {
      ids.push(parseOpaqueRecordId(part));
    } catch {
      return { ok: false, bad: part };
    }
  }
  return { ok: true, ids };
}

/**
 * The option a form value names, by id first and by label second.
 *
 * @param options - the schema's options, as the readable shape carries them (id plus name).
 * @param value - what the form holds.
 * @returns the canonical option id, or null when nothing matches.
 */
export function optionIdFor(options: readonly { id: string; name: string }[], value: string): OpaqueSchemaOptionId | null {
  const trimmed = value.trim();
  const byId = options.find((option) => option.id === trimmed);
  if (byId !== undefined) return parseOpaqueSchemaOptionId(byId.id);
  const byLabel = options.find((option) => option.name === trimmed);
  return byLabel === undefined ? null : parseOpaqueSchemaOptionId(byLabel.id);
}

/**
 * What a form's property field amounts to as canonical data.
 *
 * @param schema - the property's schema, as the readable state carries it.
 * @param field - the field's current value, flags and selections.
 * @returns the stored value, null for a clear, or a typed refusal.
 */
export function planPropertyMutation(
  schema: PropertySchema | undefined,
  field: PropertyFieldValue,
): PropertyMutationPlan {
  if (schema === undefined) {
    return refused('unknown-schema', 'no schema record defines this property');
  }

  if (schema.type === 'rollup' || schema.type === 'formula') {
    return refused('unsupported-field', `a ${schema.type} value is derived, so it is not the record's to set`);
  }

  switch (schema.type) {
    case 'text': {
      const value = field.value;
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: blank(value) ? null : { type: 'text', value } };
    }
    case 'number': {
      if (blank(field.value)) return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: null };
      const parsed = Number(field.value.trim());
      if (!Number.isFinite(parsed)) return refused('validation-refused', 'a number property needs a number');
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: { type: 'number', value: parsed } };
    }
    case 'date': {
      if (blank(field.value)) return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: null };
      const value = field.value.trim();
      if (!Number.isFinite(Date.parse(value))) return refused('validation-refused', 'a date property needs a readable instant');
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: { type: 'date', value } };
    }
    case 'checkbox':
      // False is a value for a checkbox: there is no way for the form to say "unset" about one.
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: { type: 'checkbox', value: field.checked } };
    case 'select': {
      if (blank(field.value)) return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: null };
      const optionId = optionIdFor(schema.options ?? [], field.value);
      if (optionId === null) return refused('validation-refused', `no option of ${schema.name} is called ${field.value.trim()}`);
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: { type: 'select', optionId } };
    }
    case 'multi-select': {
      const chosen = field.selected.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (chosen.length === 0) return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: null };
      const optionIds: OpaqueSchemaOptionId[] = [];
      for (const entry of chosen) {
        const optionId = optionIdFor(schema.options ?? [], entry);
        if (optionId === null) return refused('validation-refused', `no option of ${schema.name} is called ${entry}`);
        optionIds.push(optionId);
      }
      return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: { type: 'multi-select', optionIds } };
    }
    case 'relation': {
      if (blank(field.value)) return { ok: true, schemaVersion: PROPERTY_MUTATION_PLAN_VERSION, value: null };
      const parsed = relationIds(field.value);
      if (!parsed.ok) return refused('validation-refused', `a relation holds record ids, and ${parsed.bad} is not one`);
      return {
        ok: true,
        schemaVersion: PROPERTY_MUTATION_PLAN_VERSION,
        value: {
          type: 'relation',
          // The canonical record requires the relation to name the schema it belongs to, and the
          // codec refuses a value whose `relationSchemaId` is not the property key — so the schema's
          // own id is what goes here, not a caller's idea of it.
          value: { relationSchemaId: parseOpaqueRecordId(schema.id), targetRecordIds: parsed.ids },
        },
      };
    }
  }
}
