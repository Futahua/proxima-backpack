/**
 * The dependency rule, enforced rather than described.
 *
 * `src/domain` imports nothing outside itself. This is the whole reason the project
 * exists: the plugin's logic bent to whatever Obsidian supported, and it did so one
 * convenient import at a time. A rule that lives only in a README gets broken by
 * someone who never read it, so it lives here too.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) {
        out.push({ path: relative(srcRoot, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(srcRoot, directory));
  return out;
}

/** Every module specifier a file imports or re-exports from. */
function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) specifiers.push(match[1] as string);
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

const FORBIDDEN_IN_DOMAIN = [
  { label: 'Obsidian', test: (s: string) => s === 'obsidian' || s.startsWith('obsidian/') },
  { label: 'Electron', test: (s: string) => s === 'electron' || s.startsWith('electron/') },
  { label: 'Node builtins', test: (s: string) => s.startsWith('node:') || NODE_BARE.has(s) },
  { label: 'Svelte', test: (s: string) => s === 'svelte' || s.startsWith('svelte/') },
  { label: 'Papers', test: (s: string) => s.includes('papers') },
];

const NODE_BARE = new Set(['fs', 'path', 'url', 'os', 'crypto', 'child_process', 'worker_threads']);

describe('src/domain has no dependencies outside itself', () => {
  const domain = sourceFiles('domain');

  it('contains modules to check', () => {
    expect(domain.length).toBeGreaterThan(0);
  });

  it('imports no host, framework or filesystem package', () => {
    const violations: string[] = [];
    for (const file of domain) {
      for (const specifier of importsOf(file.text)) {
        if (specifier.startsWith('.')) continue;
        const hit = FORBIDDEN_IN_DOMAIN.find((rule) => rule.test(specifier));
        if (hit) violations.push(`${file.path} imports ${specifier} (${hit.label})`);
        else violations.push(`${file.path} imports the external package ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports no sibling layer', () => {
    const violations: string[] = [];
    for (const file of domain) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith('.')) continue;
        if (specifier.startsWith('./')) continue;
        violations.push(`${file.path} reaches outside the domain: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('reads no ambient clock or random identity', () => {
    const violations: string[] = [];
    for (const file of domain) {
      // clock.ts is where injectable time and identity are defined; it is the one
      // place allowed to name the real implementations.
      if (file.path === 'domain/clock.ts') continue;
      if (/\bDate\.now\s*\(/.test(file.text)) violations.push(`${file.path} calls Date.now()`);
      if (/\bcrypto\.randomUUID\s*\(/.test(file.text)) {
        violations.push(`${file.path} generates a random id`);
      }
      if (/\bMath\.random\s*\(/.test(file.text)) violations.push(`${file.path} calls Math.random()`);
    }
    expect(violations).toEqual([]);
  });
});

describe('adapters hold no business rules', () => {
  it('never mentions a Proxima domain concept', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('adapters')) {
      for (const term of ['elastic', 'timeline', 'backlog', 'deadline', 'projectType']) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(file.text)) {
          violations.push(`${file.path} mentions ${term}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('no Obsidian compatibility layer exists', () => {
  it('declares no fake App, Vault, TFile or WorkspaceLeaf', () => {
    const violations: string[] = [];
    for (const directory of ['domain', 'ports', 'adapters', 'app']) {
      for (const file of sourceFiles(directory)) {
        for (const shim of ['TFile', 'TFolder', 'WorkspaceLeaf', 'MetadataCache', 'ItemView']) {
          if (file.text.includes(shim)) violations.push(`${file.path} declares ${shim}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('wikilink semantics stay out of the interface', () => {
  /**
   * `[[target]]`, or the word for it. A nested array literal looks like `[[` too, so the
   * pattern demands a closing `]]` with something between.
   */
  const WIKILINK = /\[\[[^[\]]+\]\]|\bwikilinks?\b/i;

  it('never appears in the browser layer', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('browser')) {
      if (WIKILINK.test(file.text)) violations.push(`${file.path} mentions wikilink syntax`);
    }
    expect(violations).toEqual([]);
  });

  it('appears only where a raw asset embed is decoded', () => {
    const carriers: string[] = [];
    for (const directory of ['domain', 'app', 'ports', 'adapters', 'browser']) {
      for (const file of sourceFiles(directory)) {
        if (WIKILINK.test(file.text)) carriers.push(file.path);
      }
    }

    // Relation, rollup and formula projection must never learn to parse `[[...]]`: a
    // relation is a record id, and reading a link out of text is exactly the host-syntax
    // dependence this project exists to remove. The syntax survives in one place only —
    // the Excalidraw asset path, where an `![[asset]]` embed is really decoded.
    expect(carriers.sort()).toEqual([
      'app/excalidrawAssetLoader.ts',
      'domain/excalidraw.ts',
      'domain/excalidrawAssets.ts',
    ]);
  });
});
