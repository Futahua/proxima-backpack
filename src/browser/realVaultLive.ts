import type { RefreshResult } from '../app/refreshController.js';
import type { ReadOnlyProjection } from '../app/readOnlyProjection.js';

export interface LiveRefreshEvidence {
  outcome: RefreshResult['outcome'];
  changed: boolean;
  previousGeneration: number;
  currentGeneration: number;
  beforeRevision: string;
  afterRevision: string;
  beforeMarker: string;
  afterMarker: string;
}

export interface LiveRenameDeleteEvidence {
  outcome: 'deleted' | 'renamed';
  removedPath: string;
  addedPath?: string;
}

function records(projection: ReadOnlyProjection): Map<string, string> {
  return new Map([
    ...projection.state.projects.map((record) => [`project:${record.id}`, record.source.path] as const),
    ...projection.state.tasks.map((record) => [`task:${record.id}`, record.source.path] as const),
    ...projection.state.events.map((record) => [`event:${record.id}`, record.source.path] as const),
  ]);
}

function changedPath(previous: ReadOnlyProjection, next: ReadOnlyProjection): string {
  const candidates = [...new Set([...Object.keys(previous.revisions), ...Object.keys(next.revisions)])].sort();
  return candidates.find((path) => previous.revisions[path] !== next.revisions[path]) ?? candidates[0] ?? '';
}

/** Derive edit evidence from the normal refresh result and two accepted projections. */
export function refreshEvidenceFromProjections(previous: ReadOnlyProjection | null, next: ReadOnlyProjection, result: RefreshResult): LiveRefreshEvidence {
  const path = changedPath(previous ?? next, next);
  const beforeRevision = previous?.revisions[path] ?? '';
  const afterRevision = next.revisions[path] ?? '';
  return {
    outcome: result.outcome,
    changed: result.changed,
    previousGeneration: previous?.generation ?? Math.max(0, next.generation - (result.changed ? 1 : 0)),
    currentGeneration: next.generation,
    beforeRevision,
    afterRevision,
    beforeMarker: beforeRevision,
    afterMarker: afterRevision,
  };
}

/** Derive rename/delete evidence from source identity/path deltas, never from a manual PASS bit. */
export function renameDeleteEvidenceFromProjections(previous: ReadOnlyProjection | null, next: ReadOnlyProjection, outcome: RefreshResult['outcome']): LiveRenameDeleteEvidence | null {
  if (!previous || (outcome !== 'deleted' && outcome !== 'renamed')) return null;
  const before = records(previous);
  const after = records(next);
  if (outcome === 'renamed') {
    for (const [identity, oldPath] of before) {
      const newPath = after.get(identity);
      if (newPath && newPath !== oldPath) return { outcome: 'renamed', removedPath: oldPath, addedPath: newPath };
    }
  }
  const removed = [...new Set([...Object.keys(previous.revisions)].filter((path) => !(path in next.revisions)))].sort()[0];
  if (removed) {
    const added = [...new Set([...Object.keys(next.revisions)].filter((path) => !(path in previous.revisions)))].sort()[0];
    return outcome === 'renamed' && added ? { outcome: 'renamed', removedPath: removed, addedPath: added } : { outcome: 'deleted', removedPath: removed };
  }
  return null;
}
