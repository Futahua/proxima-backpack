import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Executes the shipped artifact — `public/build/browser/main.js`, the exact bytes a
 * Papers host serves — against the tracked `public/index.html`, and pins the
 * semantic-key contract the host validates before it accepts an observation.
 *
 * The contract is Papers': `src/shared/visualSemanticKeys.ts` accepts at most 256
 * keys, each 1-128 characters matching `^[A-Za-z0-9][A-Za-z0-9._~-]*$`, with no
 * duplicate inside one payload. A payload that breaks any of those rules is
 * **dropped in silence** (`registerVisualSemanticKeysIpc` swallows the parse
 * error), so a violation here is not a cosmetic problem: the surface becomes
 * invisible to `inspect.visual.elements` with no diagnostic anywhere.
 *
 * Why the built bundle and not the sources: a live Papers surface reported zero
 * semantic keys while every source-level string assertion passed, and the artefact
 * is what actually runs. `npm test` builds before it runs, so this file always
 * exercises a current bundle; a direct `vitest run` on a clean tree has no build
 * output, and then the case is skipped rather than silently passing.
 */
const HOST_ATTRIBUTE = 'data-papers-visual-key';
const RETIRED_ATTRIBUTE = ['data', 'c1', 'key'].join('-');
const HOST_KEY_MAX_COUNT = 256;
const HOST_KEY_MAX_LENGTH = 128;
const HOST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const MINIMUM_APP_KEYS = 60;

const projectRoot = resolve(import.meta.dirname, '..');
const bundlePath = resolve(projectRoot, 'public/build/browser/main.js');
const shellPath = resolve(projectRoot, 'public/index.html');
const built = existsSync(bundlePath);

interface ObservedDocument {
  keys: string[];
  retired: number;
  bootState: string | null;
  close: () => void;
}

async function observeBuiltArtifact(): Promise<ObservedDocument> {
  const { Window } = (await import('happy-dom')) as { Window: new (options: { url: string }) => Record<string, any> };
  const window = new Window({ url: 'papers-backpack://bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1/_papers-open/00000000-0000-4000-8000-000000000000/public/index.html' });
  const document = window['document'] as Document;
  document.write(readFileSync(shellPath, 'utf8'));

  // The bundle is browser code: it reads its globals from whatever context loads it.
  const names = ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'performance', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'File', 'Blob', 'FileReader', 'URL', 'DOMException', 'TextEncoder', 'TextDecoder', 'crypto', 'HTMLElement', 'Element', 'Node', 'Image'];
  const previous = new Map<string, unknown>();
  for (const name of names) {
    const value = (window as Record<string, unknown>)[name];
    if (value === undefined) continue;
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    try { (globalThis as Record<string, unknown>)[name] = value; } catch { /* a read-only global is left as it was */ }
  }

  // Loaded from a computed specifier: this is the file a Papers host fetches, not a
  // module the test runner should resolve. The specifier is spelled without percent
  // escapes so the runner's resolver matches it against the real path (the project
  // directory contains a space).
  const specifier = `file:///${bundlePath.replace(/\\/g, '/')}`;
  await import(/* @vite-ignore */ specifier);
  // The app hydrates synchronously after module evaluation; one macrotask is
  // enough for the shell it renders to be in the document.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const keys: string[] = [];
  document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).forEach((element) => keys.push(element.getAttribute(HOST_ATTRIBUTE) as string));
  const observed: ObservedDocument = {
    keys,
    retired: document.querySelectorAll(`[${RETIRED_ATTRIBUTE}]`).length,
    bootState: document.querySelector('#proxima-app')?.getAttribute('data-proxima-boot-state') ?? null,
    close: () => {
      for (const [name, value] of previous) {
        try { (globalThis as Record<string, unknown>)[name] = value; } catch { /* nothing to restore */ }
      }
      (window as { happyDOM?: { abort?: () => void } }).happyDOM?.abort?.();
    },
  };
  return observed;
}

const observed = built ? await observeBuiltArtifact() : null;
afterAll(() => { observed?.close(); });

describe.skipIf(!built)('the shipped bundle publishes semantic keys the host accepts', () => {
  it('boots the app and replaces the boot panel', () => {
    expect(observed!.bootState).toBe('ready');
    expect(observed!.keys).toContain('app-root');
    expect(observed!.keys.length).toBeGreaterThanOrEqual(MINIMUM_APP_KEYS);
  });

  it('keeps every key inside the host bound, because an over-bound payload is dropped whole', () => {
    expect(observed!.keys.length).toBeLessThanOrEqual(HOST_KEY_MAX_COUNT);
    for (const key of observed!.keys) {
      expect(key.length).toBeGreaterThanOrEqual(1);
      expect(key.length).toBeLessThanOrEqual(HOST_KEY_MAX_LENGTH);
      expect(HOST_KEY_PATTERN.test(key)).toBe(true);
    }
  });

  it('publishes one payload the host would accept without amendment', () => {
    const unique = new Set(observed!.keys);
    expect(unique.size).toBe(observed!.keys.length);
  });

  it('publishes no key under the retired attribute name', () => {
    expect(observed!.retired).toBe(0);
  });
});

describe.skipIf(built)('shipped bundle evidence', () => {
  it('is unavailable until the project is built', () => {
    // `npm test` runs `npm run build` first, so the audited path always has a
    // bundle. A bare `vitest run` on a clean tree does not, and this case says so
    // instead of reporting a pass it did not earn.
    expect(built).toBe(false);
  });
});
