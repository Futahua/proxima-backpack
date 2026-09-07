import type { Project } from '../domain/types.js';

export interface ProjectPresentation {
  id: string;
  name: string;
  typeLabel: string;
  statusLabel: string;
  description: string;
  linkedFolders: Array<{ name: string; path: string }>;
  sourcePath: string;
  sourceIdOrigin: string;
}

/** Read-only fields the browser may expose without opening or mutating a source. */
export function projectPresentation(project: Project): ProjectPresentation {
  return {
    id: project.id,
    name: project.name,
    typeLabel: project.projectType === 'schedule' ? 'Calendar project' : 'Task project',
    statusLabel: project.status === 'archived' ? 'Archived' : 'Active',
    description: project.description,
    linkedFolders: project.linkedFolders.map((folder) => ({ ...folder })),
    sourcePath: project.source.path,
    sourceIdOrigin: project.source.idOrigin,
  };
}
