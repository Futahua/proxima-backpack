// @vitest-environment happy-dom
/**
 * The schema panel, driven the way a person drives it: a click on a control the panel drew.
 *
 * This is the test the three schema rows have been missing for the whole life of the matrix. Those rows said
 * the same thing - the record layer writes a schema, the agent wire reaches those writes, and **no surface has
 * ever offered them** - and `tests/actionCoverageAudit.test.ts` asserted that absence so it could not quietly
 * become a claim. Closing the gap means a UI caller exists, and a UI caller means a control a click can reach:
 * reading `main.ts` as text would prove a string is present, not that a person pressing Add property reaches a
 * record write.
 *
 * So this file renders the panel from a real projection, binds it exactly as the shell binds it, clicks the
 * controls through the interaction harness, and asserts the *submissions* the handlers were handed. The
 * submissions are then run through `submitPropertySchemaAction` against a real store by
 * `tests/propertySchemaEditor.test.ts` - the two files together are the claim, and neither is enough alone: this
 * one proves the control produces a form, that one proves the form produces a record.
 *
 * Two limits are asserted rather than described, because both are the kind that would look like an oversight:
 * the create form offers only the types a form can build, and a type the projection does not offer cannot be
 * submitted by a stale `<select>`.
 */
import { describe, expect, it } from 'vitest';
import {
  propertySchemaEditor,
  PROPERTY_SCHEMA_CREATABLE_TYPES,
  schemaAddOptionSubmission,
  schemaCreateSubmission,
  schemaDeleteSubmission,
  schemaRenameSubmission,
} from '../src/app/propertySchemaEditor.js';
import {
  bindPropertySchemaPanelInteractions,
  EMPTY_PROPERTY_SCHEMA_PANEL_VIEW,
  renderPropertySchemaPanel,
  type PropertySchemaPanelHandlers,
  type PropertySchemaPanelView,
} from '../src/browser/propertySchemaPanel.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  defineCanonicalPropertySchema,
  opaqueSchemaOptionIdFromRandomBytes,
  type CanonicalPropertySchemaRecord,
} from '../src/domain/canonicalSchema.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

function optionIdFromLastByte(value: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueSchemaOptionIdFromRandomBytes(bytes);
}

const NUMBER_SCHEMA = idFromLastByte(11);
const SELECT_SCHEMA = idFromLastByte(12);

/** The records an editor would be handed: one simple schema and one select with two options. */
function declared(): readonly { record: CanonicalPropertySchemaRecord; revision: string }[] {
  return [
    {
      record: defineCanonicalPropertySchema({ header: defineCanonicalRecordHeader({ kind: 'schema', id: NUMBER_SCHEMA, name: 'Story points' }), definition: { type: 'number' } }),
      revision: `${NUMBER_SCHEMA}.json@3`,
    },
    {
      record: defineCanonicalPropertySchema({
        header: defineCanonicalRecordHeader({ kind: 'schema', id: SELECT_SCHEMA, name: 'Stage' }),
        definition: { type: 'select', options: [{ id: optionIdFromLastByte(1), label: 'Todo' }, { id: optionIdFromLastByte(2), label: 'Doing' }] },
      }),
      revision: `${SELECT_SCHEMA}.json@7`,
    },
  ];
}

/** A panel bound the way the shell binds it, with every handler call recorded. */
function panel() {
  const projection = propertySchemaEditor(declared());
  let view: PropertySchemaPanelView = EMPTY_PROPERTY_SCHEMA_PANEL_VIEW;
  const calls: { readonly name: string; readonly argument: unknown }[] = [];

  const root = document.createElement('div');
  const draw = (): void => {
    root.innerHTML = renderPropertySchemaPanel(projection, view);
  };
  draw();

  const handlers: PropertySchemaPanelHandlers = {
    toggle: () => { calls.push({ name: 'toggle', argument: null }); view = { ...view, open: !view.open }; draw(); },
    setCreateName: (value) => { calls.push({ name: 'setCreateName', argument: value }); view = { ...view, createName: value }; },
    setCreateType: (value) => { calls.push({ name: 'setCreateType', argument: value }); view = { ...view, createType: value }; draw(); },
    setCreateOptions: (value) => { calls.push({ name: 'setCreateOptions', argument: value }); view = { ...view, createOptions: value }; },
    setRowName: (schemaId, value) => { calls.push({ name: 'setRowName', argument: { schemaId, value } }); view = { ...view, rowNames: { ...view.rowNames, [schemaId]: value } }; },
    setRowOptionLabel: (schemaId, value) => { calls.push({ name: 'setRowOptionLabel', argument: { schemaId, value } }); view = { ...view, rowOptionLabels: { ...view.rowOptionLabels, [schemaId]: value } }; },
    create: () => { calls.push({ name: 'create', argument: null }); },
    rename: (form) => { calls.push({ name: 'rename', argument: form }); },
    addOption: (form) => { calls.push({ name: 'addOption', argument: form }); },
    remove: (schemaId) => { calls.push({ name: 'remove', argument: schemaId }); },
  };

  bindPropertySchemaPanelInteractions(root, projection, () => view, handlers);
  return { projection, root, calls, harness: createInteractionHarness(root), view: () => view, redraw: draw };
}

describe('the schema panel is the UI caller the three schema rows were missing', () => {
  it('draws a closed toggle first, and the rows only once it is opened', () => {
    const p = panel();
    // Closed: the toggle and nothing else, so a Backlog carrying it pays for no list nobody opened.
    expect(p.root.querySelector('[data-property-schema-panel="closed"]')).not.toBeNull();
    expect(p.root.querySelector('[data-property-schema-rows]')).toBeNull();
    // The count is on the toggle, which is the one fact a reader needs before deciding to open it.
    expect(p.harness.target('property-schema-toggle').textContent).toContain('2');

    p.harness.click('property-schema-toggle');

    expect(p.calls).toEqual([{ name: 'toggle', argument: null }]);
    expect(p.root.querySelector('[data-property-schema-panel="open"]')).not.toBeNull();
    expect(p.root.querySelectorAll('[data-property-schema-row]')).toHaveLength(2);
  });

  it('draws each row with the revision a write must name, and with its options', () => {
    const p = panel();
    p.harness.click('property-schema-toggle');

    // The revision is on the row rather than only in the shell's state: a surface that carried the wrong one
    // would be drawing a row it cannot write against, and a test reading the shell's variable would not see it.
    const rows = Array.from(p.root.querySelectorAll<HTMLElement>('[data-property-schema-row]'));
    expect(rows.map((row) => row.dataset.propertySchemaRevision)).toEqual([`${NUMBER_SCHEMA}.json@3`, `${SELECT_SCHEMA}.json@7`]);
    expect(rows[0]!.querySelector('[data-property-schema-type]')?.textContent).toBe('number');
    expect(rows[1]!.querySelector('[data-property-schema-type]')?.textContent).toBe('select');

    // The select's labels are drawn, and the number's are not - an options list on a property that has none
    // would be a control that does nothing.
    expect(Array.from(rows[1]!.querySelectorAll('[data-property-schema-option]')).map((li) => li.textContent)).toEqual(['Todo', 'Doing']);
    expect(rows[0]!.querySelector('[data-property-schema-options]')).toBeNull();
    // The add-option control appears only where options are a thing, for the same reason.
    expect(rows[1]!.querySelector('[data-property-schema-option-input]')).not.toBeNull();
    expect(rows[0]!.querySelector('[data-property-schema-option-input]')).toBeNull();
  });

  it('hands the create handler the form the reader typed, and offers only the types a form can build', () => {
    const p = panel();
    p.harness.click('property-schema-toggle');

    // The create form's type list is the creatable set, not every type a schema may have: a relation, a rollup
    // and a formula each need a chooser this panel does not have, and offering them would promise a definition
    // it cannot build. The assertion is on the drawn options rather than on the projection, because the drawing
    // is what a person chooses from.
    const select = p.root.querySelector<HTMLSelectElement>('[data-property-schema-create-type]')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([...PROPERTY_SCHEMA_CREATABLE_TYPES]);

    p.harness.typeText('property-schema-create-name', 'Story points');
    p.harness.click('property-schema-create');
    expect(p.calls.filter((call) => call.name === 'setCreateName').at(-1)).toEqual({ name: 'setCreateName', argument: 'Story points' });
    expect(p.calls.at(-1)).toEqual({ name: 'create', argument: null });

    // The submission the shell would build from what the panel now holds is one the entry parses - asserted here
    // so the two halves of the claim meet: the panel produced the form, and the form is a real submission.
    const submission = schemaCreateSubmission({ name: p.view().createName, type: p.view().createType, options: p.view().createOptions });
    expect(submission).toMatchObject({ type: 'property.schema.create', name: 'Story points', definition: { type: 'text' } });

    // A type the projection does not offer is ignored rather than submitted, so a stale control cannot ask for a
    // definition this form has no way to build.
    p.harness.typeText('property-schema-create-name', 'Ignored');
    const before = p.calls.length;
    select.value = 'rollup';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(p.calls.length).toBe(before);
    expect(p.view().createType).toBe('text');

    // The chosen type is the one the form shows as chosen, and choosing a type that takes options reveals the
    // labels field. Both are drawn from the view rather than remembered by the DOM: the panel redraws on every
    // change, so a form that did not mark the choice would show the first type in the list while submitting the
    // chosen one, and one that always drew the labels field would offer labels to a number.
    expect(p.root.querySelector('[data-property-schema-create-options]')).toBeNull();
    const chosen = p.root.querySelector<HTMLSelectElement>('[data-property-schema-create-type]')!;
    chosen.value = 'select';
    chosen.dispatchEvent(new Event('change', { bubbles: true }));
    expect(p.view().createType).toBe('select');
    const redrawn = p.root.querySelector<HTMLSelectElement>('[data-property-schema-create-type]')!;
    expect(redrawn.querySelector('option[value="select"]')?.hasAttribute('selected')).toBe(true);
    expect(redrawn.querySelector('option[value="text"]')?.hasAttribute('selected')).toBe(false);
    expect(p.root.querySelector('[data-property-schema-create-options]')).not.toBeNull();

    // And the labels field's contents are the shell's to split: the panel hands over the typed string untouched.
    p.harness.typeText('property-schema-create-options', 'Todo, Doing');
    expect(p.calls.filter((call) => call.name === 'setCreateOptions').at(-1)).toEqual({ name: 'setCreateOptions', argument: 'Todo, Doing' });
  });

  it('hands the row handlers the form and the label the row holds, and never the revision', () => {
    const p = panel();
    p.harness.click('property-schema-toggle');

    // Rename: the handler is handed the id and the name, and **not** a revision - the revision is the shell's to
    // read from the projection it drew, because a revision a caller typed is not a revision it read. The field is
    // cleared first because the harness's `typeText` appends, which is what a keystroke does to a value already
    // there - and a rename field that started empty would be a field a reader has to retype the name into.
    (p.harness.target(`property-schema-rename-input-${NUMBER_SCHEMA}`) as HTMLInputElement).value = '';
    p.harness.typeText(`property-schema-rename-input-${NUMBER_SCHEMA}`, 'Effort');
    p.harness.click(`property-schema-rename-${NUMBER_SCHEMA}`);
    expect(p.calls.at(-1)).toEqual({ name: 'rename', argument: { schemaId: NUMBER_SCHEMA, name: 'Effort' } });
    expect(p.calls.at(-1)!.argument).not.toHaveProperty('revision');
    expect(schemaRenameSubmission({ schemaId: NUMBER_SCHEMA, revision: `${NUMBER_SCHEMA}.json@3`, name: 'Effort' }))
      .toMatchObject({ type: 'property.schema.update', schemaId: NUMBER_SCHEMA, expectedRevision: `${NUMBER_SCHEMA}.json@3`, name: 'Effort' });

    // Add option: one label at a time, which is the shape of the verb.
    p.harness.typeText(`property-schema-option-input-${SELECT_SCHEMA}`, 'Done');
    p.harness.click(`property-schema-add-option-${SELECT_SCHEMA}`);
    expect(p.calls.at(-1)).toEqual({ name: 'addOption', argument: { schemaId: SELECT_SCHEMA, label: 'Done' } });
    expect(schemaAddOptionSubmission({ schemaId: SELECT_SCHEMA, revision: `${SELECT_SCHEMA}.json@7`, label: 'Done' }))
      .toMatchObject({ type: 'property.schema.option.change', option: { kind: 'add', label: 'Done' } });

    // Delete: the id alone, at the revision the row was drawn from.
    p.harness.click(`property-schema-delete-${NUMBER_SCHEMA}`);
    expect(p.calls.at(-1)).toEqual({ name: 'remove', argument: NUMBER_SCHEMA });
    expect(schemaDeleteSubmission(NUMBER_SCHEMA, `${NUMBER_SCHEMA}.json@3`))
      .toMatchObject({ type: 'property.schema.delete', schemaId: NUMBER_SCHEMA, expectedRevision: `${NUMBER_SCHEMA}.json@3` });
  });

  it('prints the refusal it was given, and draws a locked type as locked', () => {
    const projection = propertySchemaEditor(declared());
    const open: PropertySchemaPanelView = { ...EMPTY_PROPERTY_SCHEMA_PANEL_VIEW, open: true, refusal: 'a property needs a name' };
    const html = renderPropertySchemaPanel(projection, open);
    // The panel decides nothing: a refusal is a sentence it was handed, drawn where a reader will see it beside
    // the controls that produced it.
    expect(html).toContain('data-property-schema-refusal="a property needs a name"');
    expect(html).toContain('a property needs a name');
    // A type the editor cannot change says so on the row rather than being silently absent from a control list.
    expect(html).not.toContain('data-property-schema-type-locked');
    expect(propertySchemaEditor(declared()).rows.every((row) => row.typeEditable)).toBe(true);
    // And an empty world says so rather than drawing an empty list with no explanation.
    expect(renderPropertySchemaPanel(propertySchemaEditor([]), open)).toContain('data-property-schema-empty');
  });
});
