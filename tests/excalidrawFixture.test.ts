/**
 * The Excalidraw display scenario, driven from a fixture vault instead of an inline payload.
 *
 * Gate 11's scenario list asks for an "Excalidraw display fixture", and until now the display work was
 * proven only against payloads written inside `tests/excalidraw.test.ts` - real ones, but never a
 * *fixture a scenario runner can be pointed at*. This file is that fixture's test. It reads
 * `fixtures/vault-drawing` off disk as bytes and drives both fences the Obsidian plugin writes:
 *
 * - `Mood board.excalidraw.md` is the plain `json` fence, carrying the element vocabulary the renderer
 *   supports (`freedraw`, `text`, `line`, `arrow`), and it has to render **completely**;
 * - `Compressed sketch.excalidraw.md` is the `compressed-json` fence the plugin actually writes,
 *   carrying a genuinely compressed payload, and it has to decode - with one element outside the
 *   supported vocabulary, which the renderer must **report** rather than drop silently.
 *
 * And one boundary, in the second case: neither drawing is a record. Loading the vault as a record
 * source finds nothing and says nothing, because a drawing lives beside the record directories rather
 * than in them.
 */
import { describe, expect, it } from 'vitest';
import { recogniseExcalidraw } from '../src/domain/excalidraw.js';
import { renderExcalidrawSvg } from '../src/domain/excalidrawRender.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { fixtureFiles, fixtureVault } from './fixtures.js';

const BOARD = 'Proxima/drawings/Mood board.excalidraw.md';
const SKETCH = 'Proxima/drawings/Compressed sketch.excalidraw.md';

describe('Gate 11 Excalidraw display fixture', () => {
  it('renders the plain-json drawing completely, from the vault it ships in', () => {
    const bytes = fixtureFiles('vault-drawing')[BOARD] as string;
    const artifact = recogniseExcalidraw(bytes, BOARD);

    expect(artifact.kind).toBe('obsidian-envelope');
    expect(artifact.encoding).toBe('json');
    expect(artifact.problems).toEqual([]);
    // The envelope's own text elements are read as text, with the anchor only where the plugin wrote one.
    expect(artifact.textElements.map((element) => element.anchor)).toEqual(['fixtureAnchor', null]);

    const scene = artifact.scene;
    expect(scene).not.toBeNull();
    expect(scene?.elements).toHaveLength(4);

    const rendered = renderExcalidrawSvg(scene);
    expect(rendered.svg).toContain('<svg');
    // Complete means complete: every element drawn, nothing unsupported, nothing reported.
    expect(rendered.census.sceneElements).toBe(4);
    expect(rendered.census.rendered).toBe(4);
    expect(rendered.census.unsupported).toBe(0);
    expect(rendered.problems).toEqual([]);
  });

  it('decodes the compressed drawing and reports what it cannot draw instead of dropping it', () => {
    const bytes = fixtureFiles('vault-drawing')[SKETCH] as string;
    const artifact = recogniseExcalidraw(bytes, SKETCH);

    expect(artifact.encoding).toBe('compressed-json');
    expect(artifact.problems).toEqual([]);
    expect(artifact.scene?.elements).toHaveLength(3);

    const rendered = renderExcalidrawSvg(artifact.scene);
    // The census has to account for every element: a type outside the supported vocabulary is counted
    // and named, and the drawing it belongs to still renders the rest.
    expect(rendered.census.sceneElements).toBe(3);
    expect(rendered.census.rendered + rendered.census.unsupported).toBe(3);
    expect(rendered.census.unsupported).toBe(1);
    expect(rendered.problems).toContainEqual({ code: 'unsupported-element', elementType: 'rectangle', count: 1 });
    expect(rendered.svg).toContain('<svg');
  });

  it('keeps both drawings out of the record source without reporting them as problems', async () => {
    const loaded = await loadVaultState(fixtureVault('vault-drawing'));
    expect(loaded.state.tasks).toEqual([]);
    expect(loaded.state.projects).toEqual([]);
    expect(loaded.state.events).toEqual([]);
    // A drawing beside the record directories is not a record and not a problem: the reader walks where
    // records live, so an unrelated Markdown file costs nothing and reports nothing.
    expect(loaded.problems).toEqual([]);
  });
});
