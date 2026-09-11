import {
  describeTemplateTask,
  parseTemplatePlan,
  type TemplateComposerError,
  type TemplatePlan,
} from '../app/templateComposer.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Why Execute cannot run yet, said where the button is. */
export const TEMPLATE_EXECUTE_REFUSAL:
  'action-not-available' =
    'action-not-available';

/** The sentence beside the refused Execute button. */
export const TEMPLATE_EXECUTE_NOTE:
  string =
    'Execution unavailable until task records can be written. Nothing has been created.';

/** One error, with the line and column a reader can go to. */
function renderError(error: TemplateComposerError): string {
  return `<li class="template-error" data-template-error="${escapeHtml(error.code)}" data-template-error-line="${error.line}" data-template-error-column="${error.column}"><strong>Line ${error.line}, column ${error.column}</strong><span>${escapeHtml(error.message)}</span><code>${escapeHtml(error.text)}</code></li>`;
}

/** One planned task, described in the order its fields matter. */
function renderPreview(plan: TemplatePlan): string {
  if (plan.tasks.length === 0) {
    return '<p class="template-empty" data-template-preview-empty="true">Nothing to plan yet.</p>';
  }

  return `<ol class="template-preview-list" data-template-preview-count="${plan.tasks.length}">${plan.tasks.map((task) => `<li data-template-preview-task="${escapeHtml(task.name)}" data-template-preview-line="${task.line}"><strong>${escapeHtml(task.name)}</strong><span>${escapeHtml(describeTemplateTask(task))}</span></li>`).join('')}</ol>`;
}

export interface TemplateComposerPanelOptions {
  /** The template as typed or pasted. */
  text: string;
  /** Whether the panel is showing at all. */
  open: boolean;
  /** False while the view belongs to another project, so nothing here acts on it. */
  active: boolean;
}

/**
 * The template composer.
 *
 * It parses what is in the box on every render and shows three things side by side: the text,
 * the tasks it read, and one positioned complaint per line it could not read. Parsing on
 * every render is deliberately cheap and stateless — the alternative is a second copy of the
 * text's meaning living in view state, which is how a preview and a parser drift apart.
 *
 * Execute is refused with a typed result rather than hidden: execution is Stage 16's job, and
 * a button that cannot run should say so where it is.
 */
export function renderTemplateComposerPanel(options: TemplateComposerPanelOptions): string {
  if (!options.open || !options.active) return '';

  const plan = parseTemplatePlan(options.text);
  const off = options.active ? '' : ' disabled';
  const errors = plan.errors.length === 0
    ? '<p class="template-ok" data-template-errors-clean="true">No problems found.</p>'
    : `<ul class="template-errors" data-template-error-count="${plan.errors.length}">${plan.errors.map(renderError).join('')}</ul>`;

  return `<section class="template-composer" role="dialog" aria-modal="false" aria-label="Tasks from a template" data-template-composer data-template-line-count="${plan.lineCount}" data-c1-key="template-composer"><header class="surface-header"><div><p class="eyebrow">Template</p><h3>Tasks from a template</h3></div><button type="button" class="icon-button" data-project-backlog-action="close-template" data-c1-key="template-composer-close" aria-label="Close template composer">×</button></header><p class="template-help" data-template-help="true">One task per line. Indent a field under it, like <code>weight: 3</code>. <code>#</code> starts a comment, and <code>property.area: work</code> sets a custom property.</p><label>Template<textarea data-template-text data-c1-key="template-text" rows="8"${off}>${escapeHtml(options.text)}</textarea></label><div class="template-columns"><section data-template-preview><h4>Preview</h4>${renderPreview(plan)}</section><section data-template-report><h4>Problems</h4>${errors}</section></div><footer><button type="button" data-project-backlog-action="close-template" data-c1-key="template-composer-cancel">Cancel</button><button type="button" disabled data-template-execute data-template-execute-refusal="${escapeHtml(TEMPLATE_EXECUTE_REFUSAL)}" data-c1-key="template-execute">Create tasks</button><small data-c1-key="template-execute-note">${escapeHtml(TEMPLATE_EXECUTE_NOTE)}</small></footer></section>`;
}
