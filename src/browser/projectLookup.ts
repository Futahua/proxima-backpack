import type { ProximaState } from '../domain/types.js';

/** One render-scoped index for project labels used by task and event cards. */
export function createProjectNameLookup(state: ProximaState): Map<string, string> {
  return new Map(state.projects.map((project) => [project.id, project.name]));
}

export function projectLabel(lookup: Map<string, string>, projectId: string | null): string {
  if (!projectId) return 'Uncategorised';
  return lookup.get(projectId) ?? projectId;
}
