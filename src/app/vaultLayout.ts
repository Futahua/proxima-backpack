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
