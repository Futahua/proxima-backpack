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
 *
 * Gate 14's enrollment gate added a third string, and it exists because the first two were not
 * enough: "fixture" and "live data" must be unmistakable to a reader who is about to be offered a
 * mutation, and the *reason* a mutation is refused has to be the same fact the gate refused on.
 * So the badge and the admission sentence are both rendered from `admitWrite`'s verdict rather than
 * from a parallel guess about it.
 */
import { DEFAULT_WRITE_ENROLLMENT, admitWrite, type WriteAdmission, type WriteAdmissionRefusal } from '../app/writeAdmission.js';
import { evaluateFsaWriteBoundary } from '../app/fsaWriteBoundary.js';
import type { SourceMode } from '../app/sourceSession.js';

/**
 * The record type the header asks the gate about.
 *
 * It is the one whose write path this shell actually resolves, because a gate asked about a record
 * type nobody writes answers a question nobody asked. Gate 14's "one smallest record type enabled
 * first" is therefore visible in the source as well as in the checklist.
 */
export const SURFACE_RECORD_TYPE = 'task';

/** What the header badge calls the source this page is reading. */
export function sourceLabelFor(mode: SourceMode): string {
  if (mode === 'external') {
    // Live data, named as live: this is the creator's own vault behind a reader this process did
    // not create, and no other mode may be described this way.
    return 'Live data · read-only';
  }
  if (mode === 'record-store') {
    // Records come from the record store; notes, drawings and attachments stay vault artifacts,
    // which is why both halves are named rather than saying "record store" and letting a reader
    // assume the vault is gone.
    return 'Record store records · vault notes';
  }
  return 'Fixture data · read-only';
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

export interface WriteAdmissionView {
  readonly admission: WriteAdmission;
  readonly liveData: boolean;
  readonly machineValue: 'allowed' | 'refused';
  readonly reason: WriteAdmissionRefusal | 'none';
  readonly sentence: string;
}

/**
 * Run the gate for the source this page is showing.
 *
 * `evaluateFsaWriteBoundary()` is called here, and this is the first runtime caller it has had since
 * it was written: the report was correct and unread, and a boundary nothing consults is a comment
 * with a type. Its `writerEnabled` is passed as *evidence* about the host rather than as a policy,
 * which is why the gate can say `native-transaction-required` without the surface having to know
 * what a compare-and-swap is.
 *
 * The enrollment is the in-tree default, always. Nothing in this repository enrolls writes; the
 * caller that would is the creator's decision, and `tests/writeAdmission.test.ts` scans the source
 * to keep it that way.
 */
export function writeAdmissionViewFor(
  mode: SourceMode,
  writesAvailable: boolean,
  recordType: string = SURFACE_RECORD_TYPE,
): WriteAdmissionView {
  const admission = admitWrite({
    sourceMode: mode,
    recordType,
    writePathAvailable: writesAvailable,
    enrollment: DEFAULT_WRITE_ENROLLMENT,
    nativeTransactionAvailable: evaluateFsaWriteBoundary().writerEnabled,
  });
  return {
    admission,
    liveData: admission.liveData,
    machineValue: admission.allowed ? 'allowed' : 'refused',
    reason: admission.allowed ? 'none' : admission.reason,
    sentence: writeAdmissionSentenceFor(admission),
  };
}

/**
 * One sentence for the refusal, in the product's own words.
 *
 * It says *refused* rather than *unavailable*, because these are different facts: a missing write
 * path is a gap, while a refused live write is a rule working. A reader who cannot tell them apart
 * would file the second as a bug.
 */
export function writeAdmissionSentenceFor(admission: WriteAdmission): string {
  if (admission.allowed) {
    if (admission.sourceMode === 'record-store') return 'Writes: record store only';
    if (admission.sourceMode === 'external') return 'Writes: live data';
    return 'Writes: fixture bytes only';
  }
  if (admission.liveData) return 'Writes refused: live data is read-only';
  return 'Writes refused: no write path';
}
