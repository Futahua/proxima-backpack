import type { ReadOnlyProjectionHealth } from './readOnlyProjection.js';

const MAX_PROBLEM_CODES = 20;

export interface UiHealthModel {
  sourceRevision: number;
  applicationRevision: number;
  stale: boolean;
  degraded: boolean;
  lastSuccessfulRefreshRevision: number;
  lastRefreshReason: ReadOnlyProjectionHealth['lastRefreshReason'];
  problemCodes: ReadOnlyProjectionHealth['problemCodes'];
  status: 'healthy' | 'stale' | 'degraded';
}

/** One bounded, copy-safe health view shared by UI rendering and inspection. */
export function createUiHealthModel(health?: ReadOnlyProjectionHealth): UiHealthModel {
  const sourceRevision = health?.sourceRevision ?? 1;
  const applicationRevision = health?.applicationRevision ?? sourceRevision;
  const stale = health?.stale ?? false;
  const degraded = health?.degraded ?? false;
  return {
    sourceRevision,
    applicationRevision,
    stale,
    degraded,
    lastSuccessfulRefreshRevision: health?.lastSuccessfulRefreshRevision ?? sourceRevision,
    lastRefreshReason: health?.lastRefreshReason ?? null,
    problemCodes: [...new Set(health?.problemCodes ?? [])].slice(0, MAX_PROBLEM_CODES),
    status: degraded ? 'degraded' : stale ? 'stale' : 'healthy',
  };
}
