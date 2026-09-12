/**
 * The template panel's execution states, which it now has without becoming clickable on its own.
 *
 * The rule this file protects: `executable` defaults to false, so teaching the renderer to *draw* an enabled
 * Execute button does not make it enabled anywhere. The shell turns it on in the same change that adds the
 * click branch, which is why the default case here asserts the disabled button and its sentence - the state
 * the product is honestly in until that branch exists.
 *
 * A result never closes the panel and never hides the template: a partial run reports what was created, what
 * failed, and leaves the text in place, which is the AUTHOR's rule for Confirm.
 */
import { describe, expect, it } from 'vitest';

import {
  renderTemplateComposerPanel,
  TEMPLATE_EXECUTE_NOTE,
  TEMPLATE_EXECUTE_PLAN_INVALID_NOTE,
  TEMPLATE_EXECUTE_REFUSAL,
  TEMPLATE_EXECUTE_RUNNING_NOTE,
} from '../src/browser/templateComposerPanel.js';

const VALID = 'Write the brief\n  weight: 3';
const INVALID = '  weight: 3\nWrite the brief';

const render = (options: Record<string, unknown> = {}) => renderTemplateComposerPanel({
  text: VALID,
  open: true,
  active: true,
  ...options,
} as never);

describe('template composer execution states', () => {
  it('keeps Execute disabled until the caller says execution is wired', () => {
    const html = render();
    expect(html).toContain('data-template-execute');
    expect(html).toContain('disabled');
    expect(html).toContain(`data-template-execute-refusal="${TEMPLATE_EXECUTE_REFUSAL}"`);
    expect(html).toContain(TEMPLATE_EXECUTE_NOTE);
    expect(html).not.toContain('data-action="template-execute"');
  });

  it('draws an enabled button that names the shell action once execution is wired', () => {
    const html = render({ executable: true });
    expect(html).toContain('data-action="template-execute"');
    expect(html).not.toContain('data-template-execute-refusal');
    expect(html).not.toContain(TEMPLATE_EXECUTE_NOTE);
  });

  it('refuses on a template that does not parse, whatever the caller wired', () => {
    const html = render({ text: INVALID, executable: true });
    expect(html).toContain('data-template-execute-refusal="plan-invalid"');
    expect(html).toContain(TEMPLATE_EXECUTE_PLAN_INVALID_NOTE);
    expect(html).not.toContain('data-action="template-execute"');
    expect(html).toContain('data-template-error-count');
  });

  it('waits while a submission is in flight', () => {
    const html = render({ executable: true, executing: true });
    expect(html).toContain('data-template-execute-refusal="action-in-flight"');
    expect(html).toContain(TEMPLATE_EXECUTE_RUNNING_NOTE);
    expect(html).not.toContain('data-action="template-execute"');
  });

  it('reports a completed run without taking the template away', () => {
    const html = render({ executable: true, result: { created: ['pxr_a', 'pxr_b'], failure: null } });
    expect(html).toContain('data-template-result');
    expect(html).toContain('data-template-result-created="2"');
    expect(html).toContain('data-template-result-partial="false"');
    expect(html).toContain('data-template-created-id="pxr_a"');
    // The template text stays in the box, so a correction is possible without retyping.\n    expect(html).toContain(VALID.split('\n')[0] ?? '');
    // And the button is ready for another run.\n    expect(html).toContain('data-action="template-execute"');
  });

  it('reports a partial run as unfinished, with the ids and the failure, and leaves the panel usable', () => {
    const html = render({
      executable: true,
      result: { created: ['pxr_a'], failure: 'a task with that name already exists' },
    });
    expect(html).toContain('data-template-result-created="1"');
    expect(html).toContain('data-template-result-partial="true"');
    expect(html).toContain('data-template-created-id="pxr_a"');
    expect(html).toContain('a task with that name already exists');
    expect(html).toContain('data-template-text');
    expect(html).toContain('data-action="template-execute"');
  });

  it('reports a refusal that created nothing as nothing created', () => {
    const html = render({ executable: true, result: { created: [], failure: 'the template did not parse' } });
    expect(html).toContain('data-template-result-created="0"');
    expect(html).toContain('data-template-result-partial="false"');
    expect(html).toContain('Nothing was created.');
    expect(html).toContain('the template did not parse');
  });
});
