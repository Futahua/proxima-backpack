/**
 * Where records live in a vault.
 *
 * Two real layouts exist and both must be readable without migrating anything:
 *
 *   preferred  <root>/projects  <root>/tasks  <root>/events        (default root "Proxima")
 *   legacy     -Hide/Proxima/projects | tasks | events             (the old plugin's defaults)
 *
 * Each directory is configured independently rather than derived from a single root,
 * because a real vault is allowed to have been rearranged by hand — the creator may
 * have moved tasks out of the hidden folder and left events behind. A layout that can
 * only express "one root" would force a migration to read data that is already fine.
 */
import type { RecordKind } from '../domain/records.js';

export interface VaultLayout {
  projects: string;
  tasks: string;
  events: string;
}

/** The preferred Proxima-native layout. `Proxima` is the default root. */
export const PREFERRED_ROOT = 'Proxima';

/** The old plugin's default location. Read for compatibility; never written back. */
export const LEGACY_ROOT = '-Hide/Proxima';

export function layoutForRoot(root: string): VaultLayout {
  const base = trimSlashes(root);
  const prefix = base ? `${base}/` : '';
  return {
    projects: `${prefix}projects`,
    tasks: `${prefix}tasks`,
    events: `${prefix}events`,
  };
}

export const PREFERRED_LAYOUT: VaultLayout = layoutForRoot(PREFERRED_ROOT);
export const LEGACY_LAYOUT: VaultLayout = layoutForRoot(LEGACY_ROOT);

/**
 * Build a layout from a root and/or explicit per-directory overrides.
 * An override always wins over the root, so a half-moved vault stays readable.
 */
export function resolveLayout(options: {
  root?: string;
  layout?: Partial<VaultLayout>;
} = {}): VaultLayout {
  const base = layoutForRoot(options.root ?? PREFERRED_ROOT);
  const override = options.layout ?? {};
  return {
    projects: trimSlashes(override.projects ?? base.projects),
    tasks: trimSlashes(override.tasks ?? base.tasks),
    events: trimSlashes(override.events ?? base.events),
  };
}

export function directoryFor(layout: VaultLayout, kind: RecordKind): string {
  if (kind === 'project') return layout.projects;
  if (kind === 'task') return layout.tasks;
  return layout.events;
}

function trimSlashes(value: string): string {
  return value.split('\\').join('/').replace(/^\/+|\/+$/g, '');
}

/** What a read-only probe of the two canonical roots found. */
export type LayoutKind = 'preferred' | 'legacy' | 'ambiguous' | 'none';

export interface LayoutDetection {
  kind: LayoutKind;
  /** The layout to read with, or null when the caller must decide. */
  layout: VaultLayout | null;
  /** Which canonical roots actually had a readable record directory. */
  found: Array<'preferred' | 'legacy'>;
}

/**
 * Decide which canonical layout a source uses, without guessing.
 *
 * An unattended run cannot ask anyone which layout a vault has, and it must not
 * search the tree for something that looks close enough — a recursive hunt through
 * a creator's vault is exactly the behaviour this project refuses. So the probe is
 * narrow: exactly the two roots Proxima already supports, checked read-only.
 *
 * Finding both is reported as `ambiguous` rather than resolved by precedence.
 * Silently preferring one would mean reading half a vault and calling it the whole
 * thing, and the caller cannot tell that happened from a successful-looking result.
 */
export async function detectLayout(vault: {
  list(directory: string): Promise<Array<{ path: string; kind: 'file' | 'directory' }>>;
}): Promise<LayoutDetection> {
  const candidates: Array<{ name: 'preferred' | 'legacy'; layout: VaultLayout }> = [
    { name: 'preferred', layout: PREFERRED_LAYOUT },
    { name: 'legacy', layout: LEGACY_LAYOUT },
  ];

  const found: Array<'preferred' | 'legacy'> = [];
  for (const candidate of candidates) {
    if (await hasAnyRecordDirectory(vault, candidate.layout)) found.push(candidate.name);
  }

  if (found.length === 0) return { kind: 'none', layout: null, found };
  if (found.length > 1) return { kind: 'ambiguous', layout: null, found };
  const only = found[0] as 'preferred' | 'legacy';
  return { kind: only, layout: only === 'preferred' ? PREFERRED_LAYOUT : LEGACY_LAYOUT, found };
}

/** A root counts as present when at least one of its record directories reads. */
async function hasAnyRecordDirectory(
  vault: { list(directory: string): Promise<unknown[]> },
  layout: VaultLayout,
): Promise<boolean> {
  for (const directory of [layout.projects, layout.tasks, layout.events]) {
    try {
      await vault.list(directory);
      return true;
    } catch {
      // A directory that does not exist is not an error here; it is the answer.
    }
  }
  return false;
}
