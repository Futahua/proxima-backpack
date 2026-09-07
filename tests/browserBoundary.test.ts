import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

describe('Gate 20B browser no-Node boundary', () => {
  it('keeps the production source graph free of Node imports and runtime globals', () => {
    const violations: string[] = [];
    for (const path of filesUnder(sourceRoot, '.ts')) {
      const text = readFileSync(path, 'utf8');
      if (/(?:from\s+|import\s*\()\s*["'](?:node:|fs(?:\/|$)|path(?:\/|$)|url(?:\/|$)|os(?:\/|$)|crypto(?:\/|$)|child_process(?:\/|$))/m.test(text)) violations.push(`${path}: Node import`);
      if (/\b(?:process\.(?:env|argv|execPath|exit|exitCode)|require\s*\(|globalThis\.process)\b/m.test(text)) violations.push(`${path}: Node runtime global`);
    }
    expect(violations).toEqual([]);
  });

  it('keeps the emitted browser modules free of Node imports and runtime globals', () => {
    const violations: string[] = [];
    for (const path of filesUnder(buildRoot, '.js')) {
      const text = readFileSync(path, 'utf8');
      if (/(?:from\s+|import\s*\()\s*["'](?:node:|fs(?:\/|$)|path(?:\/|$)|url(?:\/|$)|os(?:\/|$)|crypto(?:\/|$)|child_process(?:\/|$))/m.test(text)) violations.push(`${path}: Node import`);
      if (/\b(?:process\.(?:env|argv|execPath|exit|exitCode)|require\s*\(|globalThis\.process)\b/m.test(text)) violations.push(`${path}: Node runtime global`);
    }
    expect(violations).toEqual([]);
  });
});
