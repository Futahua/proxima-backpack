/**
 * The composer's Execute control, bound in a module a test can import.
 *
 * The AUTHOR ruled on 2026-09-12 that reading `main.ts` as text cannot prove this chain runs: the shell
 * composes on import, so no test can import it, and "the click branch names the action" is a claim about a
 * string rather than about a listener. So the binding lives here, and `main.ts` calls it instead of keeping
 * a copy of its own. What stays in the shell is only what the shell owns - where the template text comes
 * from, where a run's two states are kept, and what else it owes once a run finishes.
 *
 * The submission is not reimplemented here. This calls `executeTemplateAction`, which parses the template
 * text itself, so the panel's Confirm, an agent's submission and this click all reach one path - which is
 * the property the Stage 17 equivalence box is about.
 */
import { executeTemplateAction, type TemplateExecuteDependencies } from '../app/templateExecuteAction.js';
import type { TemplateComposerResult } from './templateComposerPanel.js';

/** The verb the composer's Execute control dispatches. The panel declares it on the button. */
export const TEMPLATE_EXECUTE_ACTION = 'template-execute' as const;

export interface TemplateExecuteHandlers {
  /** The template as it stands at click time: read here, not captured when the shell bound this. */
  readonly template: () => string;
  /** The action's dependencies, resolved per run the way the shell resolves them for any other write. */
  readonly action: () => TemplateExecuteDependencies;
  /** The run started: the view records that it is in flight so the panel can say so rather than look idle. */
  readonly begin: () => void;
  /** The run ended: what it created, and the sentence when it stopped before the end. */
  readonly finish: (result: TemplateComposerResult) => void;
  /** What else the shell owes after a run - re-reading the source, in the shipped shell. */
  readonly afterRun?: () => void | Promise<void>;
}

/**
 * Bind Execute on a rendered composer.
 *
 * One listener on the root rather than one on the button: the panel is re-rendered on every state change, so
 * a listener attached to the button would be discarded by the first render after a click. The listener is
 * bound once and resolves the control from the event, which is also what keeps it working across renders.
 */
export function bindTemplateExecuteInteractions(
  root: HTMLElement,
  handlers: TemplateExecuteHandlers,
): void {
  let running = false;

  const run = async (): Promise<void> => {
    // A second click while a run is in flight would create the same tasks twice. The panel disables the
    // button during a run, but a disabled button is presentation and this is the rule.
    if (running) return;
    running = true;
    const template = handlers.template();
    const action = handlers.action();
    handlers.begin();
    action.render();
    try {
      const result = await executeTemplateAction(action, { template });
      handlers.finish({
        created: [...result.created],
        failure: result.ok ? null : result.detail,
      });
      action.render();
      await handlers.afterRun?.();
    } finally {
      running = false;
    }
  };

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest(`[data-action="${TEMPLATE_EXECUTE_ACTION}"]`);
    if (control === null || !root.contains(control)) return;
    void run();
  });
}
