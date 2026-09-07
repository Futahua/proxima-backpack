import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

function filesUnder(root: string, extension: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith(extension)) out.push(path);
    }
  };
  visit(root);
  return out;
}

const sourceRoot = resolve(process.cwd(), 'src');
const buildRoot = resolve(process.cwd(), 'public/build');
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name.slice(5) : `node:${name}`]));

function scan(text: string): string[] {
  const violations: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g;
  for (const match of code.matchAll(importPattern)) {
    const specifier = match[1] as string;
    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (nodeBuiltins.has(specifier) || nodeBuiltins.has(bare) || nodeBuiltins.has(`node:${bare}`)) violations.push(`Node import: ${specifier}`);
  }
  if (/\b(?:process|Buffer|__dirname|__filename|require)\b/.test(code)) violations.push('Node runtime global');
  return violations;
}

describe('Gate 20B browser no-Node boundary', () => {
  it('recognizes the exhaustive builtin/global vocabulary', () => {
    expect(scan("import { Worker } from 'worker_threads'; const bytes = Buffer.from('x');" )).toEqual([
      'Node import: worker_threads',
      'Node runtime global',
    ]);
    expect(scan("import 'node:fs';")).toEqual(['Node import: node:fs']);
  });

  it('keeps the production source graph free of Node imports and runtime globals', () => {
    const violations: string[] = [];
    for (const path of filesUnder(sourceRoot, '.ts')) {
      const text = readFileSync(path, 'utf8');
      for (const issue of scan(text)) violations.push(`${path}: ${issue}`);
    }
    expect(violations).toEqual([]);
  });

  it('keeps the emitted browser modules free of Node imports and runtime globals', () => {
    const violations: string[] = [];
    for (const path of filesUnder(buildRoot, '.js')) {
      const text = readFileSync(path, 'utf8');
      for (const issue of scan(text)) violations.push(`${path}: ${issue}`);
    }
    expect(violations).toEqual([]);
  });
});
