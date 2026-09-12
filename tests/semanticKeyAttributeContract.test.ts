import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCockpitNavigation } from '../src/browser/cockpitNavigation.js';

/**
 * Papers observes exactly one semantic-key attribute, and it owns the name:
 * `PAPERS 3\Papers-3\src\preload\projectVisualSemanticKeys.ts` reads
 * `data-papers-visual-key` and nothing else, and `src/AGENTS.md` documents that
 * attribute as the project's stable semantic name. The renderer previously emitted
 * `data-c1-key`, so a live C1 surface reached `layout-stable` with 165 semantic keys
 * in its markup and `inspect.visual.elements` still observed zero elements.
 *
 * These cases pin the name on both sides of the boundary that broke: the source the
 * project ships, and a rendered surface. The attribute the host reads is restated
 * here rather than imported, because `src/` and `tests/` must not reach into the
 * Papers checkout.
 */
const HOST_ATTRIBUTE = 'data-papers-visual-key';
// Assembled rather than spelled: this file lives inside the scan that forbids it.
const RETIRED_ATTRIBUTE = ['data', 'c1', 'key'].join('-');
// The retired name also reaches code through the DOM's camelCase projection
// (`dataset.c1Key`), which a literal attribute rename cannot see. The scan is a
// case-insensitive pattern so every spelling of that name is caught.
const RETIRED_PATTERN = /c1-?key/i;

const projectRoot = resolve(import.meta.dirname, '..');

function relativeFiles(directory: string, extension: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) found.push(full);
    }
  };
  walk(resolve(projectRoot, directory));
  return found.sort();
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function offenders(files: string[], pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(projectRoot.length + 1).replace(/\\/g, '/'));
}

const sourceFiles = relativeFiles('src', '.ts');
// This case file quotes the retired name in its rationale, so it exempts itself by
// path: every other test file still has to pass the scan.
const contractFile = resolve(import.meta.dirname, 'semanticKeyAttributeContract.test.ts');
const testFiles = relativeFiles('tests', '.ts').filter((file) => file !== contractFile);

describe('semantic key attribute contract', () => {
  it('names every semantic key the way the host reads it', () => {
    const carriers = sourceFiles.filter((file) => readFileSync(file, 'utf8').includes(HOST_ATTRIBUTE));
    const total = sourceFiles.reduce((sum, file) => sum + occurrences(readFileSync(file, 'utf8'), HOST_ATTRIBUTE), 0);
    // Measured on the tree that closed Gate 2: 25 browser modules, 324 occurrences.
    expect(carriers.length).toBeGreaterThanOrEqual(20);
    expect(total).toBeGreaterThanOrEqual(300);
  });

  it('emits no semantic key under a name the host cannot read', () => {
    expect(offenders(sourceFiles, RETIRED_PATTERN)).toEqual([]);
    expect(offenders(testFiles, RETIRED_PATTERN)).toEqual([]);
  });

  it('keeps the tracked shell boot panel on the host attribute', () => {
    const shell = readFileSync(resolve(projectRoot, 'public/index.html'), 'utf8');
    expect(shell).toContain(`${HOST_ATTRIBUTE}="boot-state"`);
    expect(shell).not.toContain(RETIRED_ATTRIBUTE);
  });

  it('renders a real navigation surface with the host attribute', () => {
    for (const surface of ['canvas', 'tasks', 'schedule', 'projects'] as const) {
      const html = renderCockpitNavigation({ surface, tasksMode: 'elastic', scheduleMode: 'day', projectWorkspaceTab: 'notes' });
      expect(html).toContain(`${HOST_ATTRIBUTE}="surface-tab-`);
      expect(html).not.toContain(RETIRED_ATTRIBUTE);
    }
  });

  it('reports an offender when a source file reintroduces the retired name', () => {
    // A checker that cannot fail is not evidence. Both spellings the retired name
    // reached code through are probed against real files that use them: the attribute
    // in a renderer, and the DOM's camelCase projection in a reader.
    const probePath = resolve(projectRoot, 'tests/semanticKeyAttributeContract.probe.ts');
    const scan = (mutated: string) => (file: string): boolean =>
      RETIRED_PATTERN.test(file === probePath ? mutated : readFileSync(file, 'utf8'));

    const rendered = readFileSync(resolve(projectRoot, 'src/browser/cockpitNavigation.ts'), 'utf8');
    const attributeSpelling = rendered.replaceAll(HOST_ATTRIBUTE, RETIRED_ATTRIBUTE);
    expect(attributeSpelling).toContain(RETIRED_ATTRIBUTE);
    expect(attributeSpelling).not.toContain(HOST_ATTRIBUTE);
    expect([...sourceFiles, probePath].filter(scan(attributeSpelling))).toEqual([probePath]);

    const reader = readFileSync(resolve(projectRoot, 'tests/scheduleWriteWiring.test.ts'), 'utf8');
    const datasetSpelling = reader.replace('dataset.papersVisualKey', 'dataset.c1Key');
    expect(datasetSpelling).toContain('dataset.c1Key');
    expect([...testFiles, probePath].filter(scan(datasetSpelling))).toEqual([probePath]);
  });
});
