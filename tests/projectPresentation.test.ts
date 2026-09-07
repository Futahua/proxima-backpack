import { describe, expect, it } from 'vitest';
import { projectPresentation } from '../src/browser/projectPresentation.js';
import { sourceRef } from './fixtures.js';

describe('Gate 6.4B read-only project presentation', () => {
  it('exposes description, linked folders, status and source provenance without write fields', () => {
    const view = projectPresentation({
      id: 'old-project',
      name: 'Old',
      description: 'Kept for reference',
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'archived',
      projectType: 'task',
      linkedFolders: [{ name: 'Notes', path: 'Notes' }],
      source: { ...sourceRef('project', 'old-project'), path: 'Proxima/projects/Old.md', idOrigin: 'frontmatter' },
    });
    expect(view).toEqual({
      id: 'old-project',
      name: 'Old',
      typeLabel: 'Task project',
      statusLabel: 'Archived',
      description: 'Kept for reference',
      linkedFolders: [{ name: 'Notes', path: 'Notes' }],
      sourcePath: 'Proxima/projects/Old.md',
      sourceIdOrigin: 'frontmatter',
    });
    expect(view).not.toHaveProperty('write');
  });
});
