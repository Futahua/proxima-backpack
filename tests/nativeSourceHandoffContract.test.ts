import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AuthenticatedBackpackRef,
  GrantedSourceRef,
  NativeSourceHandoffCapability,
} from '../src/ports/nativeSourceHandoff.js';

const PORT_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/ports/nativeSourceHandoff.ts'),
  'utf8',
);

const CANVAS_BOUNDARY_SOURCES = [
  'src/domain/canvas.ts',
  'src/browser/canvasFileAdmission.ts',
  'src/browser/canvasSurface.ts',
  'src/ports/vault.ts',
].map((path) => ({
  path,
  source: readFileSync(resolve(process.cwd(), path), 'utf8'),
}));

type Assignable<From, To> = From extends To ? true : false;

const BACKPACK_REF_IS_SOURCE_REF:
  Assignable<AuthenticatedBackpackRef, GrantedSourceRef> = false;

const SOURCE_REF_IS_BACKPACK_REF:
  Assignable<GrantedSourceRef, AuthenticatedBackpackRef> = false;

describe('Gate 9.2 smallest host capability', () => {
  it('binds open and reveal to one authenticated Backpack and opaque granted source reference', async () => {
    const backpack =
      'authenticated-backpack-ref' as AuthenticatedBackpackRef;
    const source =
      'opaque-granted-source-ref' as GrantedSourceRef;

    const calls: Array<{
      action: 'open' | 'reveal';
      source: GrantedSourceRef;
    }> = [];

    const capability: NativeSourceHandoffCapability = {
      backpack,
      open: async (grantedSource) => {
        calls.push({
          action: 'open',
          source: grantedSource,
        });
      },
      reveal: async (grantedSource) => {
        calls.push({
          action: 'reveal',
          source: grantedSource,
        });
      },
    };

    expect(BACKPACK_REF_IS_SOURCE_REF).toBe(false);
    expect(SOURCE_REF_IS_BACKPACK_REF).toBe(false);
    expect(Object.keys(capability).sort()).toEqual([
      'backpack',
      'open',
      'reveal',
    ]);
    expect(capability.backpack).toBe(backpack);

    await capability.open(source);
    await capability.reveal(source);

    expect(calls).toEqual([
      {
        action: 'open',
        source,
      },
      {
        action: 'reveal',
        source,
      },
    ]);
  });

  it('keeps the host contract free of Proxima semantic vocabulary and machine locators', () => {
    for (const term of [
      'project',
      'task',
      'canvas',
      'excalidraw',
      'obsidian',
    ]) {
      expect(
        new RegExp(`\\b${term}\\b`, 'i').test(PORT_SOURCE),
      ).toBe(false);
    }

    for (const primitive of [
      'absolutePath',
      'nativePath',
      'fileHandle',
      'FileSystemFileHandle',
      'showOpenFilePicker',
      'shell.openPath',
      'shell.showItemInFolder',
      'path:',
    ]) {
      expect(PORT_SOURCE).not.toContain(primitive);
    }
  });

  it('does not wire the host capability into current Canvas state, admission, rendering, or reader boundaries', () => {
    for (const { source } of CANVAS_BOUNDARY_SOURCES) {
      expect(source).not.toContain('nativeSourceHandoff');
      expect(source).not.toContain(
        'NativeSourceHandoffCapability',
      );
      expect(source).not.toContain('AuthenticatedBackpackRef');
      expect(source).not.toContain('GrantedSourceRef');
    }
  });
});
