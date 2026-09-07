/**
 * Recognising an Excalidraw artifact by its structure.
 *
 * Two shapes exist in a real vault. A native `.excalidraw` file is a JSON document.
 * A drawing made through the Obsidian Excalidraw plugin is a Markdown *envelope*:
 * frontmatter, a human-readable text/embed summary, and a fenced `Drawing` block
 * holding the scene as either `json` or `compressed-json`.
 *
 * Two rules shape this module.
 *
 * Recognition is structural, never by filename. A file called `notes.md` containing
 * a valid envelope is a drawing; a file called `sketch.excalidraw` containing prose
 * is not. Trusting the name would mean the surface confidently mis-rendering
 * whatever happened to be named conveniently.
 *
 * Nothing here decodes or repairs. It reports what the artifact *is* — including
 * that a payload is compressed and this build cannot yet decode it — because a
 * bounded "unsupported" is a usable diagnostic, while a guess is not. Opening a
 * drawing must never change its bytes, so no path in this file rewrites anything.
 */

import { decompressFromBase64 } from './excalidraw-lz-string.js';

export type ExcalidrawEncoding = 'json' | 'compressed-json' | 'unknown';

export type ExcalidrawKind = 'native-json' | 'obsidian-envelope' | 'not-excalidraw';

export interface ExcalidrawTextElement {
  text: string;
  /** The plugin's element anchor, when the line carries one. */
  anchor: string | null;
}

export interface ExcalidrawEmbeddedFile {
  /** The plugin's content hash for the embed. */
  key: string;
  /** The vault link it resolves through. Never resolved here. */
  link: string;
}

export interface ExcalidrawArtifact {
  kind: ExcalidrawKind;
  encoding: ExcalidrawEncoding;
  /** Scene payload exactly as found. Not decoded, not normalised. */
  payload: string | null;
  /** Parsed scene, only when it was plain JSON and parsed cleanly. */
  scene: ExcalidrawScene | null;
  textElements: ExcalidrawTextElement[];
  embeddedFiles: ExcalidrawEmbeddedFile[];
  /** Why a recognised artifact cannot be displayed yet, if so. */
  problems: ExcalidrawProblem[];
}

export interface ExcalidrawScene {
  type?: string;
  version?: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export type ExcalidrawProblemCode =
  /** The drawing block is present but this build cannot decode its encoding. */
  | 'encoding-unsupported'
  /** The encoding is known but this particular payload would not decode. */
  | 'decode-failed'
  /** The payload claimed to be JSON and was not. */
  | 'payload-unparsable'
  /** Parsed, but the object is not an Excalidraw scene. */
  | 'scene-shape-invalid'
  /** An envelope with no drawing block at all. */
  | 'drawing-block-missing'
  /** An embed line the plugin's format did not explain. */
  | 'embed-unreadable'
  /** The envelope contains more embedded-file mappings than this build can audit. */
  | 'embed-limit-exceeded';

export interface ExcalidrawProblem {
  code: ExcalidrawProblemCode;
  detail: string;
}

const NOT_EXCALIDRAW: ExcalidrawArtifact = {
  kind: 'not-excalidraw',
  encoding: 'unknown',
  payload: null,
  scene: null,
  textElements: [],
  embeddedFiles: [],
  problems: [],
};

/** Bounded so one enormous drawing cannot dominate a report. */
const MAX_TEXT_ELEMENTS = 200;
const MAX_EMBEDDED_FILES = 200;
const MAX_DETAIL = 200;

/**
 * Classify a file's text. `path` is used only to choose which shape to try first;
 * it never decides the answer.
 */
export function recogniseExcalidraw(text: string, path = ''): ExcalidrawArtifact {
  if (typeof text !== 'string' || text.trim() === '') return NOT_EXCALIDRAW;

  const envelope = recogniseEnvelope(text);
  if (envelope) return envelope;

  const native = recogniseNativeJson(text);
  if (native) return native;

  // A `.excalidraw` name that holds neither shape is a mislabelled file, and saying
  // so is more useful than pretending it is a drawing.
  if (/\.excalidraw$/i.test(path)) {
    return {
      ...NOT_EXCALIDRAW,
      problems: [{ code: 'payload-unparsable', detail: 'named .excalidraw but holds neither a scene nor an envelope' }],
    };
  }
  return NOT_EXCALIDRAW;
}

function recogniseNativeJson(text: string): ExcalidrawArtifact | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isSceneLike(parsed)) return null;
  return {
    kind: 'native-json',
    encoding: 'json',
    payload: trimmed,
    scene: parsed,
    textElements: [],
    embeddedFiles: [],
    problems: [],
  };
}

/** The Obsidian plugin's Markdown envelope. */
function recogniseEnvelope(text: string): ExcalidrawArtifact | null {
  const declaresPlugin = /^---[\s\S]*?excalidraw-plugin\s*:/m.test(text);
  const hasDrawingHeading = /^#+\s*Drawing\s*$/m.test(text);
  const hasDataHeading = /^#+\s*Excalidraw Data\s*$/m.test(text);
  if (!declaresPlugin && !(hasDrawingHeading && hasDataHeading)) return null;

  const problems: ExcalidrawProblem[] = [];
  const fence = /```(compressed-json|json)\s*\r?\n([\s\S]*?)```/m.exec(text);

  let encoding: ExcalidrawEncoding = 'unknown';
  let payload: string | null = null;
  let scene: ExcalidrawScene | null = null;

  if (!fence) {
    problems.push({ code: 'drawing-block-missing', detail: 'envelope declares the plugin but carries no drawing block' });
  } else {
    encoding = fence[1] === 'compressed-json' ? 'compressed-json' : 'json';
    payload = (fence[2] ?? '').trim();
    if (encoding === 'compressed-json') {
      // The payload is wrapped across lines by the plugin; the algorithm wants it
      // whole. Nothing else about it is altered.
      const decoded = decompressFromBase64(payload.split(/\s+/).join(''));
      if (decoded === null) {
        problems.push({ code: 'decode-failed', detail: 'compressed-json payload did not decode' });
      } else {
        try {
          const parsed = JSON.parse(decoded);
          if (isSceneLike(parsed)) scene = parsed;
          else problems.push({ code: 'scene-shape-invalid', detail: 'decoded payload is not an Excalidraw scene' });
        } catch (error) {
          // Decoding produced something, but not JSON. Reported rather than
          // salvaged: a scene assembled from partially decoded bytes is a drawing
          // nobody made.
          problems.push({ code: 'payload-unparsable', detail: bounded(error) });
        }
      }
    } else {
      try {
        const parsed = JSON.parse(payload);
        if (isSceneLike(parsed)) scene = parsed;
        else problems.push({ code: 'scene-shape-invalid', detail: 'drawing block parsed but is not an Excalidraw scene' });
      } catch (error) {
        problems.push({ code: 'payload-unparsable', detail: bounded(error) });
      }
    }
  }

  return {
    kind: 'obsidian-envelope',
    encoding,
    payload,
    scene,
    textElements: textElements(text),
    embeddedFiles: embeddedFiles(text, problems),
    problems,
  };
}

/**
 * The plugin's human-readable text summary. Useful on its own: it is what a canvas
 * can show for a drawing whose scene this build cannot decode yet.
 */
function textElements(text: string): ExcalidrawTextElement[] {
  const section = sectionBody(text, 'Text Elements');
  if (!section) return [];
  const out: ExcalidrawTextElement[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const anchored = /^(.*?)\s*\^([A-Za-z0-9]+)$/.exec(trimmed);
    out.push(anchored ? { text: anchored[1] ?? '', anchor: anchored[2] ?? null } : { text: trimmed, anchor: null });
    if (out.length >= MAX_TEXT_ELEMENTS) break;
  }
  return out;
}

/** `hash: [[Vault Link]]` lines. The link is recorded, never resolved here. */
function embeddedFiles(text: string, problems: ExcalidrawProblem[]): ExcalidrawEmbeddedFile[] {
  const section = sectionBody(text, 'Embedded Files');
  if (!section) return [];
  const out: ExcalidrawEmbeddedFile[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([A-Za-z0-9]+)\s*:\s*\[\[(.+?)\]\]/.exec(trimmed);
    if (!match) {
      if (problems.length < 20) problems.push({ code: 'embed-unreadable', detail: bounded(trimmed) });
      continue;
    }
    // A partial mapping is unsafe: a duplicate key after the cap could otherwise
    // be hidden from the asset loader and make the first mapping look unique.
    // Fail closed for the whole embedded-file section instead of returning a
    // silently truncated prefix.
    if (out.length >= MAX_EMBEDDED_FILES) {
      problems.push({ code: 'embed-limit-exceeded', detail: `more than ${MAX_EMBEDDED_FILES} embedded files` });
      return [];
    }
    out.push({ key: match[1] ?? '', link: match[2] ?? '' });
  }
  return out;
}

/** Body of a `## Heading` section, up to the next heading. */
function sectionBody(text: string, heading: string): string | null {
  const pattern = new RegExp(`^#+\\s*${heading}\\s*$([\\s\\S]*?)(?=^#+\\s|^%%|$(?![\\r\\n]))`, 'm');
  const match = pattern.exec(text);
  return match ? (match[1] ?? '') : null;
}

function isSceneLike(value: unknown): value is ExcalidrawScene {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExcalidrawScene>;
  if (!Array.isArray(candidate.elements)) return false;
  // `type` is the plugin's own marker; accept a scene without it only when the
  // element array is present, which is the structural minimum.
  return candidate.type === undefined || candidate.type === 'excalidraw';
}

function bounded(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, MAX_DETAIL);
}
