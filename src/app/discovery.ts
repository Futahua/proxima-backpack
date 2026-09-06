/**
 * Which files in a directory are records, and what identity a file without an
 * explicit `id` gets.
 *
 * This is deliberately positional and narrow. The alternative — "any Markdown under
 * the folder is a record" — is what makes a vault fragile: a note a creator drops
 * beside their projects becomes a phantom project, and a phantom project cannot be
 * deleted without deleting the note.
 *
 * The rules, in full:
 *
 *   projects/{id}.md            a project, id from the filename
 *   projects/{id}/index.md      a project, id from the folder name
 *   projects/{id}/anything.md   NOT a project — ordinary content inside a project
 *   projects/a/b/index.md       NOT a project — nesting is one level, not arbitrary
 *   tasks/{id}.md               a task, id from the filename
 *   events/{id}.md              an event, id from the filename
 *   tasks/sub/{id}.md           NOT a task, and reported, because no layout puts it there
 *
 * Pure string logic: no vault, no I/O. It takes the paths a walk produced and says
 * what they mean.
 */
import { baseName, type IdOrigin, type RecordKind } from '../domain/records.js';
import type { LoadProblem } from '../domain/problems.js';

export interface RecordCandidate {
  path: string;
  /** The id this file gets if its frontmatter does not declare one. */
  derivedId: string;
  derivedFrom: Exclude<IdOrigin, 'frontmatter'>;
}

export interface Discovery {
  candidates: RecordCandidate[];
  problems: LoadProblem[];
}

const MARKDOWN = /\.md$/i;
const INDEX_FILE = /^index\.md$/i;

/**
 * Projects, from a flat file or from a folder's index.
 *
 * Extra Markdown inside a project folder is silently not a project — that is the
 * expected shape of a project folder, not a mistake worth reporting.
 */
export function discoverProjects(paths: string[], directory: string): Discovery {
  const candidates: RecordCandidate[] = [];
  const problems: LoadProblem[] = [];

  for (const path of relativeTo(paths, directory)) {
    const segments = path.rest.split('/');

    if (segments.length === 1) {
      if (!MARKDOWN.test(path.rest)) continue;
      candidates.push({ path: path.full, derivedId: baseName(path.rest), derivedFrom: 'filename' });
      continue;
    }

    if (segments.length === 2 && INDEX_FILE.test(segments[1] as string)) {
      candidates.push({ path: path.full, derivedId: segments[0] as string, derivedFrom: 'folder' });
    }
    // Anything else under a project folder is that project's content, not a record.
  }

  return { candidates: sortCandidates(candidates), problems };
}

/**
 * Tasks and events: direct children of their directory only.
 *
 * Markdown nested deeper is reported rather than ignored. No layout Proxima supports
 * puts a task in a subfolder, so a task sitting there is more likely a misplaced file
 * the creator wants to know about than content that belongs where it is.
 */
export function discoverFlatRecords(
  paths: string[],
  directory: string,
  kind: RecordKind,
): Discovery {
  const candidates: RecordCandidate[] = [];
  const problems: LoadProblem[] = [];

  for (const path of relativeTo(paths, directory)) {
    if (!MARKDOWN.test(path.rest)) continue;
    if (path.rest.includes('/')) {
      problems.push({
        code: 'ignored-file',
        severity: 'warning',
        path: path.full,
        kind,
        detail: `Markdown below ${directory}/ is not read as a ${kind}; only direct children are.`,
      });
      continue;
    }
    candidates.push({ path: path.full, derivedId: baseName(path.rest), derivedFrom: 'filename' });
  }

  return { candidates: sortCandidates(candidates), problems };
}

/**
 * A `type` in frontmatter is honoured as the legacy marker it was, but discovery is
 * positional: `type: project` neither promotes a file the rules skipped nor is
 * required by a file they found. Its only remaining power is to veto — a file that
 * says it is something other than what its directory reads as is left alone.
 */
export function typeMatchesKind(declaredType: string, kind: RecordKind): boolean {
  const declared = declaredType.trim().toLowerCase();
  if (declared === '') return true;
  return declared === kind;
}

function relativeTo(paths: string[], directory: string): { full: string; rest: string }[] {
  const base = directory ? `${directory}/` : '';
  const out: { full: string; rest: string }[] = [];
  for (const full of paths) {
    if (!full.startsWith(base)) continue;
    const rest = full.slice(base.length);
    if (rest) out.push({ full, rest });
  }
  return out;
}

/** Deterministic order, so which of two colliding files is reported is never luck. */
function sortCandidates(candidates: RecordCandidate[]): RecordCandidate[] {
  return candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
