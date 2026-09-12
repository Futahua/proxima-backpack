/**
 * Stage 20's first box, as a surface: the acceptance-probe controls behind one disclosure.
 *
 * The shell used to lead with them. `Select disposable folder` and `Re-read selected folder` sat in the
 * ordinary header beside Refresh, in front of a reader who is there to use Proxima — and a folder picker
 * in the header reads as an ordinary feature, which is exactly the confusion this box is about: those
 * buttons select a *disposable* root for an acceptance run, and they neither grant nor demonstrate record
 * write authority (`evaluateFsaWriteBoundary` fails closed; `ownerAuthorityBoundary` exposes read-only
 * authority).
 *
 * So the header now offers one disclosure, closed on an ordinary boot, and the probe controls appear
 * inside it. Two things deliberately do not change with it:
 *
 * - the machine-readable inspection contract (`__PROXIMA_INSPECTION__`, the real-vault acceptance hook
 *   and the status elements an acceptance run reads) stays exactly where it was, so hiding a control
 *   from a reader never hides a fact from a program;
 * - the buttons keep their `data-action` and machine keys, so an acceptance run that opens the
 *   disclosure drives the same handlers it always did.
 */
export interface AcceptanceToolsViewState {
  /** Closed on an ordinary boot: a reader sees the product, not the harness. */
  readonly open: boolean;
}

export const EMPTY_ACCEPTANCE_TOOLS_VIEW: AcceptanceToolsViewState = {
  open: false,
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Draw the disclosure, and the probe controls only when it is open.
 *
 * @param view - whether the disclosure is open.
 * @returns the markup for the header's acceptance-tools region.
 */
export function renderAcceptanceTools(view: AcceptanceToolsViewState = EMPTY_ACCEPTANCE_TOOLS_VIEW): string {
  const toggle = `<button type="button" class="acceptance-tools-toggle" data-action="acceptance-tools" data-c1-key="acceptance-tools-toggle" aria-expanded="${view.open ? 'true' : 'false'}" aria-controls="acceptance-tools-panel">Acceptance tools</button>`;
  if (!view.open) return toggle;

  return `${toggle}<div class="acceptance-tools-panel" id="acceptance-tools-panel" data-c1-key="acceptance-tools-panel"><p class="acceptance-tools-note" data-acceptance-tools-scope="disposable-root">These select a <strong>disposable</strong> folder for an acceptance run. They do not grant record write authority: browser folder access is read-only here, and no record is written through it.</p><button type="button" data-action="fsa-probe" data-c1-key="fsa-probe-button">Select disposable folder</button><button type="button" data-action="fsa-reread" data-c1-key="fsa-reread-button">Re-read selected folder</button></div>`;
}

/** Whether a click on `data-action="acceptance-tools"` opens or closes the disclosure. */
export function acceptanceToolsAfterToggle(view: AcceptanceToolsViewState): AcceptanceToolsViewState {
  return { open: !view.open };
}
