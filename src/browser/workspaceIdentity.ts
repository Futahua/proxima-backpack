/**
 * What the product calls itself, derived rather than hardcoded.
 *
 * The shell used to say "Read-only workspace" in a literal. That was true while nothing could
 * write, and it becomes a lie the moment a run can — which is exactly what HARD GATE C's sixth
 * item is about. So the claim is a function of two facts the shell already has: where records come
 * from, and whether a record write path actually resolved. A label that tracked anything else
 * could outlive the capability it describes.
 *
 * The two are deliberately separate strings. The badge names the *source*, because a reader needs
 * to know whether they are looking at bundled fixture bytes or their own data; the identity names
 * the *capability*, because "read-only" is a promise about what the product will do to that data.
 */
import type { SourceMode } from '../app/sourceSession.js';

/** What the header badge calls the source this page is reading. */
export function sourceLabelFor(mode: SourceMode): string {
  if (mode === 'external') return 'Read-only external source';
  if (mode === 'record-store') {
    // Records come from the record store; notes, drawings and attachments stay vault artifacts,
    // which is why both halves are named rather than saying "record store" and letting a reader
    // assume the vault is gone.
    return 'Record store records · vault notes';
  }
  return 'Read-only fixture';
}

/**
 * What the brand line calls the workspace.
 *
 * A resolved record write path is the only thing that makes this product anything but read-only:
 * until one exists, every gesture is refused with a typed reason and saying so is the honest
 * answer. Once one exists, the ordinary product has to stop claiming otherwise.
 */
export function workspaceIdentityFor(mode: SourceMode, writesAvailable: boolean): string {
  if (mode !== 'record-store' || !writesAvailable) return 'Read-only workspace';
  return 'Editable workspace';
}

/** The machine-readable half, so a test or an agent need not read the sentence. */
export function workspaceWritesFor(mode: SourceMode, writesAvailable: boolean): 'available' | 'unavailable' {
  return mode === 'record-store' && writesAvailable ? 'available' : 'unavailable';
}
