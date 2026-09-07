import { describe, expect, it } from 'vitest';
import { createProjectNameLookup, projectLabel } from '../src/browser/projectLookup.js';
import type { ProximaState } from '../src/domain/types.js';
import { sourceRef } from './fixtures.js';

describe('Gate 18E render lookup indexing', () => {
  it('resolves task/event project labels from one render-scoped map', () => {
    const state = { projects: [{ id: 'p', name: 'Project', description: '', createdAt: '', status: 'active', projectType: 'task', linkedFolders: [], source: sourceRef('project', 'p') }], tasks: [], events: [], statuses: [], taskSchema: [] } as unknown as ProximaState;
    const lookup = createProjectNameLookup(state);
    expect(projectLabel(lookup, 'p')).toBe('Project');
    expect(projectLabel(lookup, 'missing')).toBe('missing');
    expect(projectLabel(lookup, null)).toBe('Uncategorised');
  });
});
