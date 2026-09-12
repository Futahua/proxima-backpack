/**
 * Stage 20's remaining transitional chrome, asserted rather than assumed.
 *
 * Three boxes, one question each, and the honest answer to two of them is "there is nothing there to
 * retire":
 *
 * - **Canvas is still a first-class surface.** It has a tab beside Tasks, Schedule and Projects, the
 *   shell routes it to the canvas renderer, and the capability's own suites — previews with byte
 *   budgets, geometry and removal interactions, semantic selection, file admission — are the evidence
 *   that it is ahead of what the old plugin had. The comparison to the plugin is the creator's
 *   judgement; what is checkable is that the capability is present and covered, and that is what this
 *   file asserts.
 * - **There are no legacy import controls in the ordinary surface**, and that is the box's own
 *   condition: import is an administrative action set on the agent path, not chrome a reader has to
 *   get past. If a UI for it is ever wanted, this assertion is what will fail and send the reader back
 *   to the box.
 * - **No migration ceremony is permanent**, because none is drawn: record-store activation is a stored
 *   marker the write path reads, not a per-boot flow.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCockpitNavigation } from '../src/browser/cockpitNavigation.js';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function bytes(path: string): number {
  return statSync(resolve(process.cwd(), path)).size;
}

const MAIN = source('src/browser/main.ts');

describe('Stage 20 canvas availability', () => {
  it('draws Canvas as a first-class surface tab, selected only when it is the surface', () => {
    const canvas = renderCockpitNavigation({
      surface: 'canvas',
      tasksMode: 'elastic',
      scheduleMode: 'day',
      projectWorkspaceTab: 'notes',
    });
    expect(canvas).toContain('data-papers-visual-key="surface-tab-canvas"');
    expect(canvas).toContain('data-surface="canvas"');
    expect(canvas).toMatch(/class="surface-tab selected"[^>]*data-papers-visual-key="surface-tab-canvas"|data-papers-visual-key="surface-tab-canvas"[^>]*selected/);

    const tasks = renderCockpitNavigation({
      surface: 'tasks',
      tasksMode: 'elastic',
      scheduleMode: 'day',
      projectWorkspaceTab: 'notes',
    });
    expect(tasks).toContain('data-papers-visual-key="surface-tab-canvas"');
    expect(tasks).not.toMatch(/class="surface-tab selected"[^>]*data-papers-visual-key="surface-tab-canvas"/);

    // The shell routes the tab to the canvas renderer rather than to a placeholder, and the switcher's
    // own validation accepts the surface: canvas is the last branch of the chain, not a fallback that
    // would swallow an unknown surface.
    expect(MAIN).toContain('renderCanvasSurface(');
    expect(MAIN).toContain("next !== 'canvas'");
  });

  it('keeps the canvas capability covered by its own suites rather than by one smoke case', () => {
    // Named capabilities, each with a suite: previews and their budgets, the three preview paths, file
    // admission, geometry and removal interactions, semantic selection, and the loader.
    const suites = [
      'tests/canvasSurface.test.ts',
      'tests/canvasRenderer.test.ts',
      'tests/canvasPreview.test.ts',
      'tests/canvasTextPreview.test.ts',
      'tests/canvasExcalidrawPreview.test.ts',
      'tests/canvasFileAdmission.test.ts',
      'tests/canvasGeometryInteractions.test.ts',
      'tests/canvasRemovalInteractions.test.ts',
      'tests/canvasSemanticActions.test.ts',
      'tests/canvasLoader.test.ts',
    ];
    for (const suite of suites) {
      expect(bytes(suite), `${suite} must exist and carry cases`).toBeGreaterThan(500);
    }
    // And the previews are budgeted rather than unbounded: the three preview registries the shell
    // composes are the mechanism, named here so a rewrite cannot quietly drop them.
    for (const registry of ['canvasPreviewRegistry', 'canvasExcalidrawPreviewRegistry', 'canvasTextPreviewRegistry']) {
      expect(MAIN, `${registry} must stay composed`).toContain(registry);
    }
  });
});

describe('Stage 20 import and migration chrome', () => {
  it('renders no legacy import control in the ordinary surface, while the administrative path stays', () => {
    // No import button, panel or wizard in the shell's markup.
    expect(MAIN).not.toContain('data-papers-visual-key="import');
    expect(MAIN).not.toContain('>Import<');
    expect(MAIN).not.toContain('Import legacy');
    // The machinery is still there for the paths that own it: the administrative action set and its
    // parser, exercised by their own suite.
    const actions = source('src/app/importAdministrativeActions.ts');
    expect(actions).toContain('export function parseLegacyImportAdministrativeAction');
    expect(actions).toContain('export function createLegacyImportAdministrativeActions');
    expect(bytes('tests/importAdministrativeActions.test.ts')).toBeGreaterThan(500);
  });

  it('keeps activation a stored marker the write path reads, not a per-boot ceremony', () => {
    // The shell draws no migration step.
    expect(MAIN).not.toContain('data-papers-visual-key="migration');
    expect(MAIN).not.toContain('data-papers-visual-key="activation-marker');
    // Activation is read where it belongs — resolving the write path — and the reader is a stored
    // marker, which is what makes "activated once" true rather than a flow repeated every boot.
    expect(source('src/adapters/browserTaskMutations.ts')).toContain('readRecordStoreActivation');
    const activation = source('src/app/recordStoreActivation.ts');
    expect(activation).toContain('export async function readRecordStoreActivation');
    // And the one thing the ordinary surface does say about a non-writable run is the derived
    // read-only state, which is a fact about this run rather than a migration prompt.
    expect(MAIN).toContain('workspaceWritesFor(sourceMode, writesAvailable)');
  });
});
