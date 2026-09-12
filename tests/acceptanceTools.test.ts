/**
 * Stage 20's first box, asserted rather than described: the ordinary surface does not lead with the
 * acceptance probes, and hiding a control never hides a fact from a program.
 *
 * The shell itself (`src/browser/main.ts`) is not importable from a test, so the evidence is in two
 * halves, the same two the other surface slices use: the region is a pure renderer that is rendered
 * here in both states, and the composition is asserted against the shell's own source — the header no
 * longer carries the probe buttons, and the machine-readable evidence the acceptance runs read is
 * still there.
 *
 * That second half matters more than it looks. The risk in "remove the probe chrome" is removing the
 * program's ability to see the same facts, so the source assertions below name the inspection hook, the
 * acceptance hook and every status element by id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptanceToolsAfterToggle,
  EMPTY_ACCEPTANCE_TOOLS_VIEW,
  renderAcceptanceTools,
} from '../src/browser/acceptanceTools.js';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const MAIN = source('src/browser/main.ts');

describe('Stage 20 acceptance-probe chrome', () => {
  it('leads with one closed disclosure, and renders no probe control until it is opened', () => {
    const closed = renderAcceptanceTools(EMPTY_ACCEPTANCE_TOOLS_VIEW);

    expect(closed).toContain('data-papers-visual-key="acceptance-tools-toggle"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="acceptance-tools-panel"');
    // No probe chrome at all while it is closed: not hidden with CSS, not present and inert.
    expect(closed).not.toContain('data-action="fsa-probe"');
    expect(closed).not.toContain('data-action="fsa-reread"');
    expect(closed).not.toContain('fsa-probe-button');
    expect(closed).not.toContain('data-papers-visual-key="acceptance-tools-panel"');

    const open = renderAcceptanceTools(acceptanceToolsAfterToggle(EMPTY_ACCEPTANCE_TOOLS_VIEW));
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('data-papers-visual-key="acceptance-tools-panel"');
    // The buttons keep the action names and machine keys the acceptance runs drive.
    expect(open).toContain('data-action="fsa-probe"');
    expect(open).toContain('data-papers-visual-key="fsa-probe-button"');
    expect(open).toContain('data-action="fsa-reread"');
    expect(open).toContain('data-papers-visual-key="fsa-reread-button"');

    // And the disclosure says what those buttons are, so a folder picker in the header cannot read as
    // an ordinary feature: disposable root, and no record write authority through it.
    expect(open).toContain('data-acceptance-tools-scope="disposable-root"');
    expect(open).toContain('<strong>disposable</strong>');
    expect(open).toContain('do not grant record write authority');

    // Toggling is the same function twice, not a mode that drifts.
    expect(acceptanceToolsAfterToggle(acceptanceToolsAfterToggle(EMPTY_ACCEPTANCE_TOOLS_VIEW)).open).toBe(false);
  });

  it('puts the disclosure in the shell header and leaves no probe button outside it', () => {
    expect(MAIN).toContain('renderAcceptanceTools(acceptanceToolsView)');
    expect(MAIN).toContain("action === 'acceptance-tools'");
    expect(MAIN).toContain('acceptanceToolsAfterToggle(acceptanceToolsView)');
    // The inline probe buttons are gone from the template: rendered by the region instead.
    expect(MAIN).not.toContain('data-action="fsa-probe"');
    expect(MAIN).not.toContain('data-action="fsa-reread"');
  });

  it('keeps the machine-readable evidence the acceptance runs read', () => {
    // The inspection report the agent path reads.
    expect(MAIN).toContain('target.__PROXIMA_INSPECTION__');
    // The hook an acceptance run declares observed evidence through.
    expect(MAIN).toContain('__PROXIMA_REAL_VAULT_ACCEPTANCE__');
    // Every status element an acceptance run reads by id, still rendered by the shell.
    for (const id of [
      'build-identity',
      'hydration-summary',
      'fsa-probe-status',
      'fsa-acceptance-status',
      'real-vault-acceptance-status',
      'creator-vault-preflight-status',
    ]) {
      expect(MAIN, `${id} must stay in the shell`).toContain(`id="${id}"`);
    }
    // And the health strip is still drawn, as the one-line surface rather than a header.
    expect(MAIN).toContain('healthSurface(health)');
    expect(MAIN).toContain('diagnosticsSurface(problems)');
  });

  it('does not let the probe controls imply record ownership', () => {
    // The boundary those buttons sit behind is asserted by its own suites: FSA write authority fails
    // closed, and the owner-authority boundary exposes read authority only.
    for (const file of ['tests/fsaWriteBoundary.test.ts', 'tests/ownerAuthorityBoundary.test.ts']) {
      expect(source(file).length, `${file} must exist and carry cases`).toBeGreaterThan(500);
    }
    const fsa = source('src/app/fsaWriteBoundary.ts');
    expect(fsa).toContain("reason: 'fsa-no-compare-and-swap'");
    expect(fsa).toContain('writerEnabled: false');
    const owner = source('src/app/ownerAuthorityBoundary.ts');
    expect(owner).toContain("writeAuthority: 'disabled'");
    // The surface says the same thing the boundary does, in the place a reader would look.
    expect(renderAcceptanceTools({ open: true })).toContain('read-only here');
  });
});
