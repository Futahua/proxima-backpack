/**
 * The UI invocation of a template, asserted the way this repository asserts its shell.
 *
 * `src/browser/main.ts` is not importable from a test — the repository says so in
 * `tests/acceptanceTools.test.ts` and every surface slice since has used the same two halves: the pure
 * renderer is rendered here, and the composition is asserted against the shell's own source. This file is
 * that second half for the template panel, and it exists because Stage 17's matrix asks for a UI invocation
 * test on the Templates row.
 *
 * What "invocation" means here, stated plainly so a later reader does not over-read it: the click chain
 * reaches the action, the action reaches the execution path with the shell's own dependencies, and the
 * outcome is held as view state the renderer already knows how to draw. The behaviour beneath those three
 * claims is covered by tests that do not need the shell — the panel states, the action outcomes, the
 * executor, the store-level equivalence and the restart case. What cannot be covered on this machine is a
 * synthetic click through the real chain, because the harness that binds the Backlog's interactions is not
 * the shell's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderTemplateComposerPanel } from '../src/browser/templateComposerPanel.js';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const MAIN = source('src/browser/main.ts');
const BACKLOG = source('src/browser/projectBacklog.ts');

/** The body of a function declared in the shell, from its signature to the closing brace at column 0. */
function shellFunction(name: string): string {
  const start = MAIN.indexOf(`async function ${name}(`);
  if (start === -1) return '';
  const end = MAIN.indexOf('\n}', start);
  return end === -1 ? MAIN.slice(start) : MAIN.slice(start, end + 2);
}

describe('template.execute UI invocation', () => {
  it('reaches the action from the click chain, on the shell own convention', () => {
    // The chain is the shell's single delegated listener over [data-action]; an action that is not named
    // there is a button that does nothing, which is exactly the lie the disabled default prevents.
    const branch = MAIN.indexOf("action === 'template-execute'");
    expect(branch).toBeGreaterThan(-1);
    const branchBody = MAIN.slice(branch, branch + 160);
    expect(branchBody).toContain('createTemplateTasksAction()');
  });

  it('runs the canonical action with the shell dependencies that already exist for task creation', () => {
    const body = shellFunction('createTemplateTasksAction');
    expect(body).not.toBe('');
    // The same dependency set the new-task form uses, which is what makes this the ordinary path rather
    // than a second one with its own authority.
    expect(body).toContain('executeTemplateAction(taskCreateDependencies(), { template: text })');
    expect(body).toContain('templateExecuting: true');
    expect(body).toContain('templateExecuting: false');
    expect(body).toContain('templateResult');
    expect(body).toContain('render()');
  });

  it('holds the outcome as view state, splitting a refusal from a clean run', () => {
    const body = shellFunction('createTemplateTasksAction');
    expect(body).toContain('result.ok');
    expect(body).toContain('created: [...result.created], failure: null');
    expect(body).toContain('created: [...result.created], failure: result.detail');
  });

  it('hands the renderer the state it draws, and only when the caller says execution is wired', () => {
    // The renderer's options are named in the backlog projection, which is where the panel is rendered.
    expect(BACKLOG).toContain('executable:true');
    expect(BACKLOG).toContain('executing:view.templateExecuting');
    expect(BACKLOG).toContain('result:view.templateResult');
    expect(BACKLOG).toContain('templateExecuting:boolean');
    expect(BACKLOG).toContain('templateResult:TemplateComposerResult|null');

    // And the pair actually agree: rendered with those options the button is offered as the shell action.
    const html = renderTemplateComposerPanel({
      text: 'Write the brief',
      open: true,
      active: true,
      executable: true,
      executing: false,
      result: null,
    });
    expect(html).toContain('data-action="template-execute"');
    expect(html).not.toContain('disabled');
  });

  it('keeps the composer open while it runs, and after a partial result', () => {
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
    expect(partial).toContain('data-template-text');
    expect(partial).toContain('data-action="template-execute"');
  });
});
