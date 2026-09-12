/**
 * The schema editor's surface: the panel that finally offers the verbs three agenda rows have been waiting for.
 *
 * The rows said the same thing for the whole life of the matrix - the record layer writes a schema, the agent
 * wire reaches those writes, and no surface has ever offered them - and the audit asserted that absence, so it
 * could not quietly become a claim. This is the other half of closing it: `src/app/propertySchemaEditor.ts`
 * turns the records into rows and a form into a submission, and this module draws those rows and binds the
 * controls that produce those forms.
 *
 * **It decides nothing.** Every rule - whether a name is acceptable, whether a definition is real, whether a
 * re-type would orphan stored values - is the record layer's, and it arrives as a refusal this panel prints.
 * The panel's own job is the one a surface has: draw what the projection says, hand the handler a form, and show
 * the sentence that came back.
 *
 * Two limits are drawn rather than hidden. **The create form offers only the types a form can build** - a
 * relation, a rollup and a formula each need a chooser this panel does not have, and the projection says which
 * those are. And **a select's options are added after its create**, one label at a time, because a canonical
 * option carries an id the record layer allocates - so the panel's create form takes labels and the shell runs
 * the create and then one option verb per label.
 */
import type { PropertySchemaEditorProjection, PropertySchemaEditorRow } from '../app/propertySchemaEditor.js';

export const PROPERTY_SCHEMA_PANEL_SCHEMA_VERSION = 1 as const;

/** What the reader has typed into the panel but not saved. */
export interface PropertySchemaPanelView {
  readonly open: boolean;
  /** The create form's fields. */
  readonly createName: string;
  readonly createType: string;
  readonly createOptions: string;
  /** The label a row's add-option field holds, keyed by schema id. */
  readonly rowOptionLabels: Readonly<Record<string, string>>;
  /** The name a row's rename field holds, keyed by schema id. */
  readonly rowNames: Readonly<Record<string, string>>;
  /** The last refusal this panel was told about, or null. */
  readonly refusal: string | null;
  /** The last accepted change's sentence, or null. */
  readonly feedback: string | null;
}

export const EMPTY_PROPERTY_SCHEMA_PANEL_VIEW: PropertySchemaPanelView = {
  open: false,
  createName: '',
  createType: 'text',
  createOptions: '',
  rowOptionLabels: {},
  rowNames: {},
  refusal: null,
  feedback: null,
};

export interface PropertySchemaPanelHandlers {
  toggle(): void;
  setCreateName(value: string): void;
  setCreateType(value: string): void;
  setCreateOptions(value: string): void;
  setRowName(schemaId: string, value: string): void;
  setRowOptionLabel(schemaId: string, value: string): void;
  /** Create the schema the form describes, then add its labels one at a time. */
  create(): void;
  rename(form: { readonly schemaId: string; readonly name: string }): void;
  addOption(form: { readonly schemaId: string; readonly label: string }): void;
  remove(schemaId: string): void;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * One schema row.
 *
 * The row carries the revision it was drawn from as a data attribute, because that is the fact a write must
 * name and this surface is where a reader triggers one - so the test can assert the drawn revision rather than
 * trusting that the shell kept it.
 */
function row(row_: PropertySchemaEditorRow, view: PropertySchemaPanelView): string {
  const id = escapeHtml(row_.schemaId);
  const options = row_.options.length === 0
    ? ''
    : `<ul class="property-schema-options" data-property-schema-options="${id}">${row_.options.map((option) => `<li data-property-schema-option="${escapeHtml(option.optionId)}" data-papers-visual-key="property-schema-option-${id}-${escapeHtml(option.optionId)}">${escapeHtml(option.label)}</li>`).join('')}</ul>`;
  const detail = row_.detail === null ? '' : `<small class="property-schema-detail" data-property-schema-detail="${id}">${escapeHtml(row_.detail)}</small>`;
  // A type the editor cannot change says so on the row rather than being silently absent from a control list:
  // the reader is looking at a select whose values may already use its options, and being told is the honest
  // version of being refused.
  const typeNote = row_.typeEditable ? '' : `<small class="property-schema-type-locked" data-property-schema-type-locked="${id}">type is fixed once values use it</small>`;
  const offersOptions = row_.type === 'select' || row_.type === 'multi-select';
  const addOption = offersOptions
    ? `<span class="property-schema-add-option"><input type="text" data-property-schema-option-input="${id}" value="${escapeHtml(view.rowOptionLabels[row_.schemaId] ?? '')}" placeholder="New option" aria-label="New option for ${escapeHtml(row_.name)}" data-papers-visual-key="property-schema-option-input-${id}"><button type="button" data-property-schema-action="add-option" data-property-schema-id="${id}" data-papers-visual-key="property-schema-add-option-${id}">Add option</button></span>`
    : '';

  return `<li class="property-schema-row" data-property-schema-row="${id}" data-property-schema-revision="${escapeHtml(row_.revision)}" data-papers-visual-key="property-schema-row-${id}"><div class="property-schema-heading"><strong data-property-schema-name="${id}">${escapeHtml(row_.name)}</strong><span data-property-schema-type="${id}">${escapeHtml(row_.type)}</span>${detail}${typeNote}</div>${options}<span class="property-schema-controls"><input type="text" data-property-schema-rename-input="${id}" value="${escapeHtml(view.rowNames[row_.schemaId] ?? row_.name)}" aria-label="Rename ${escapeHtml(row_.name)}" data-papers-visual-key="property-schema-rename-input-${id}"><button type="button" data-property-schema-action="rename" data-property-schema-id="${id}" data-papers-visual-key="property-schema-rename-${id}">Rename</button>${addOption}<button type="button" data-property-schema-action="delete" data-property-schema-id="${id}" data-papers-visual-key="property-schema-delete-${id}">Delete</button></span></li>`;
}

/**
 * Render the panel.
 *
 * A closed panel draws its toggle and nothing else, so the Backlog that carries it is not paying for a list
 * nobody opened - and the toggle is the control a test clicks, which is what makes "a surface reaches these
 * verbs" a runtime claim rather than a source reading.
 */
export function renderPropertySchemaPanel(
  projection: PropertySchemaEditorProjection,
  view: PropertySchemaPanelView = EMPTY_PROPERTY_SCHEMA_PANEL_VIEW,
): string {
  const toggle = `<button type="button" class="property-schema-toggle" data-property-schema-action="toggle" aria-expanded="${view.open ? 'true' : 'false'}" data-papers-visual-key="property-schema-toggle">Properties (${projection.declaredCount})</button>`;
  if (!view.open) {
    return `<section class="property-schema-panel closed" data-property-schema-panel="closed" data-papers-visual-key="property-schema-panel">${toggle}</section>`;
  }

  const typeOptions = projection.creatableTypes
    .map((type) => `<option value="${escapeHtml(type)}"${type === view.createType ? ' selected' : ''}>${escapeHtml(type)}</option>`)
    .join('');
  const offersOptions = projection.optionTypes.includes(view.createType);
  const createForm = `<div class="property-schema-create" data-property-schema-create><input type="text" data-property-schema-create-name value="${escapeHtml(view.createName)}" placeholder="Property name" aria-label="New property name" data-papers-visual-key="property-schema-create-name"><select data-property-schema-create-type aria-label="New property type" data-papers-visual-key="property-schema-create-type">${typeOptions}</select>${offersOptions ? `<input type="text" data-property-schema-create-options value="${escapeHtml(view.createOptions)}" placeholder="Options, comma separated" aria-label="New property options" data-papers-visual-key="property-schema-create-options">` : ''}<button type="button" data-property-schema-action="create" data-papers-visual-key="property-schema-create">Add property</button></div>`;

  const rows = projection.rows.length === 0
    ? '<p class="empty-state" data-property-schema-empty>No properties are declared yet.</p>'
    : `<ul class="property-schema-rows" data-property-schema-rows>${projection.rows.map((entry) => row(entry, view)).join('')}</ul>`;

  const refusal = view.refusal === null ? '' : `<p class="property-schema-refusal" data-property-schema-refusal="${escapeHtml(view.refusal)}">${escapeHtml(view.refusal)}</p>`;
  const feedback = view.feedback === null ? '' : `<p class="property-schema-feedback" data-property-schema-feedback="${escapeHtml(view.feedback)}">${escapeHtml(view.feedback)}</p>`;

  return `<section class="property-schema-panel open" data-property-schema-panel="open" data-papers-visual-key="property-schema-panel">${toggle}${refusal}${feedback}${createForm}${rows}</section>`;
}

function isSchemaType(value: string, projection: PropertySchemaEditorProjection): boolean {
  return projection.creatableTypes.includes(value);
}

/**
 * Bind the panel's controls.
 *
 * Delegated from the root rather than bound per control, because the panel redraws under the pointer: a
 * listener attached to a row would be attached to an element the next render replaces, which is the same reason
 * every other binder in this tree resolves the control from the event.
 *
 * @param root - the element the panel was rendered into.
 * @param projection - the same projection the render used, so a type the create form does not offer cannot be
 *   submitted by a stale `<select>` value.
 * @param readView - the view as it stands, read at event time rather than captured.
 * @param handlers - what the surface asks the shell to do.
 */
export function bindPropertySchemaPanelInteractions(
  root: HTMLElement,
  projection: PropertySchemaEditorProjection,
  readView: () => PropertySchemaPanelView,
  handlers: PropertySchemaPanelHandlers,
): void {
  const actionOf = (target: HTMLElement): { action: string; schemaId: string | null } | null => {
    const control = target.closest<HTMLElement>('[data-property-schema-action]');
    if (!control || !root.contains(control)) return null;
    const action = control.dataset.propertySchemaAction;
    if (action === undefined) return null;
    return { action, schemaId: control.dataset.propertySchemaId ?? null };
  };

  root.addEventListener('click', (event) => {
    const hit = actionOf(event.target as HTMLElement);
    if (hit === null) return;

    switch (hit.action) {
      case 'toggle':
        handlers.toggle();
        return;
      case 'create':
        handlers.create();
        return;
      case 'rename':
        if (hit.schemaId !== null) handlers.rename({ schemaId: hit.schemaId, name: readView().rowNames[hit.schemaId] ?? '' });
        return;
      case 'add-option':
        if (hit.schemaId !== null) handlers.addOption({ schemaId: hit.schemaId, label: readView().rowOptionLabels[hit.schemaId] ?? '' });
        return;
      case 'delete':
        if (hit.schemaId !== null) handlers.remove(hit.schemaId);
        return;
      default:
        return;
    }
  });

  root.addEventListener('input', (event) => {
    const field = event.target as HTMLElement;
    if (!root.contains(field)) return;
    const value = (field as HTMLInputElement).value ?? '';

    if (field.dataset.propertySchemaCreateName !== undefined) {
      handlers.setCreateName(value);
      return;
    }
    if (field.dataset.propertySchemaCreateOptions !== undefined) {
      handlers.setCreateOptions(value);
      return;
    }
    const rename = field.dataset.propertySchemaRenameInput;
    if (rename !== undefined) {
      handlers.setRowName(rename, value);
      return;
    }
    const option = field.dataset.propertySchemaOptionInput;
    if (option !== undefined) handlers.setRowOptionLabel(option, value);
  });

  root.addEventListener('change', (event) => {
    const field = event.target as HTMLElement;
    if (field.dataset.propertySchemaCreateType === undefined) return;
    // A type the projection does not offer is ignored rather than submitted: a stale control cannot ask for a
    // definition this form has no way to build.
    const value = (field as HTMLSelectElement).value ?? '';
    if (isSchemaType(value, projection)) handlers.setCreateType(value);
  });
}
