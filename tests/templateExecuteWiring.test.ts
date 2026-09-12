// @vitest-environment happy-dom
/**
 * The shell's half of the template wiring - the part a click cannot see.
 *
 * `tests/templateExecuteClick.test.ts` is the evidence for Stage 17's *UI invocation test exists*: it renders
 * the composer, binds the binding the shell binds, clicks the button and watches the action create records.
 * What a click cannot show is that the shell actually uses that binding, that the verb the panel declares is
 * the verb the binding listens for, and that the renderer is handed the shell's own view state - so those
 * three are asserted here, as a guard on the composition rather than as a substitute for the click.
 *
 * `src/browser/main.ts` is still not importable from a test (`tests/acceptanceTools.test.ts` records why), so
 * the shell-side facts are read from its source; the renderer-side facts are asserted by rendering the panel,
 * which is the difference between this file and the one it replaced.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderTemplateComposerPanel } from '../src/browser/templateComposerPanel.js';
import { TEMPLATE_EXECUTE_ACTION } from '../src/browser/templateExecuteBinding.js';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const MAIN = source('src/browser/main.ts');
const BACKLOG = source('src/browser/projectBacklog.ts');

describe('template.execute shell wiring', () => {
  it('binds the extracted module, and no longer handles the verb in its own chain', () => {
    // The AUTHOR's ruling was that this chain has to be a running listener rather than a string in a file,
    // so the shell must call the binding - and must not also keep its own branch, which would run it twice.
    expect(MAIN).toContain('bindTemplateExecuteInteractions(root, {');
    expect(MAIN).not.toContain("action === 'template-execute'");
    expect(MAIN).not.toContain('createTemplateTasksAction');
  });

  it('talks to the view the shell already keeps, rather than to a copy of it', () => {
    expect(MAIN).toContain('template: () => projectBacklogView.templateText');
    expect(MAIN).toContain('templateExecuting: true');
    expect(MAIN).toContain('templateExecuting: false');
    expect(MAIN).toContain('templateResult: result');
    // The same dependency set the new-task form uses, resolved per run rather than captured at bind time.
    expect(MAIN).toContain('action: taskCreateDependencies');
  });

  it('offers a button whose verb is the one the binding listens for', () => {
    // A runtime lockstep check: the panel's attribute is compared with the constant, so a rename in either
    // file fails here rather than producing a button that silently does nothing.
    const html = renderTemplateComposerPanel({
      text: 'Write the brief',
      open: true,
      active: true,
      executable: true,
      executing: false,
      result: null,
    });
    const host = document.createElement('div');
    document.body.append(host);
    host.innerHTML = html;
    const button = host.querySelector('[data-template-execute]');
    expect(button?.getAttribute('data-action')).toBe(TEMPLATE_EXECUTE_ACTION);
    expect(button?.getAttribute('data-c1-key')).toBe(TEMPLATE_EXECUTE_ACTION);
    expect(button?.hasAttribute('disabled')).toBe(false);
  });

  it('refuses the button until a caller says execution is wired, and keeps the composer open', () => {
    // `executable` defaults to false, which is the point: a button must not become clickable because a
    // renderer learned how to draw it enabled.
    const refused = renderTemplateComposerPanel({
      text: 'Write the brief',
      open: true,
      active: true,
      result: null,
    });
    expect(refused).toContain('data-template-execute-refusal="action-not-available"');
    expect(refused).toContain('disabled');

    const running = renderTemplateComposerPanel({
      text: 'Write the brief',
      open: true,
      active: true,
      executable: true,
      executing: true,
      result: null,
    });
    expect(running).toContain('data-template-execute-refusal="action-in-flight"');
    expect(running).toContain('data-template-text');

    const partial = renderTemplateComposerPanel({
      text: 'Write the brief',
      open: true,
      active: true,
      executable: true,
      executing: false,
      result: { created: ['pxr_a'], failure: 'the second task was refused' },
    });
    expect(partial).toContain('data-template-result-partial="true"');
    expect(partial).toContain('data-action="template-execute"');
  });

  it('hands the panel the shell state it draws, from the backlog projection', () => {
    expect(BACKLOG).toContain('executable:true');
    expect(BACKLOG).toContain('executing:view.templateExecuting');
    expect(BACKLOG).toContain('result:view.templateResult');
    expect(BACKLOG).toContain('templateExecuting:boolean');
    expect(BACKLOG).toContain('templateResult:TemplateComposerResult|null');
  });
});
