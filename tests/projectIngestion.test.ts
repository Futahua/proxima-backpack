/**
 * Gate 6.4A — project ingestion and provenance acceptance evidence.
 *
 * The browser may choose how to present projects, but ingestion must first preserve
 * the creator's records exactly: both legacy shapes, explicit identity, description
 * precedence, linked-folder encodings, and archived retention.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';

const project = (frontmatter: string, body = '') => `---\n${frontmatter}\n---\n${body}`;

describe('project ingestion acceptance', () => {
  it('loads flat and one-level index projects while ignoring notes and deeper indexes', async () => {
    const { state, problems, census } = await loadVaultState(
      createMemoryVault({
        'Proxima/projects/Flat.md': project('name: Flat\nstatus: active'),
        'Proxima/projects/Folder/index.md': project('name: Folder\nstatus: active'),
        'Proxima/projects/Folder/Notes.md': project('name: note'),
        'Proxima/projects/Folder/deep/index.md': project('name: phantom'),
        'Proxima/projects/Folder/deep/more/index.md': project('name: deeper phantom'),
      }),
    );

    expect(state.projects.map((record) => record.id)).toEqual(['Flat', 'Folder']);
    expect(problems).toEqual([]);
    expect(census.project).toMatchObject({
      status: 'complete',
      scannedFiles: 5,
      recordCandidates: 2,
      loadedRecords: 2,
      explicitlyRejected: 0,
      unaccountedCandidates: 0,
    });
  });

  it('preserves explicit project id and source provenance after a filename or folder rename', async () => {
    const { state } = await loadVaultState(
      createMemoryVault({
        'Proxima/projects/Renamed.md': project('id: stable-project\nname: Renamed flat'),
        'Proxima/projects/Folder/index.md': project('id: stable-folder\nname: Renamed folder'),
      }),
    );

    expect(state.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'stable-project',
        name: 'Renamed flat',
        source: expect.objectContaining({
          path: 'Proxima/projects/Renamed.md',
          kind: 'project',
          idOrigin: 'frontmatter',
        }),
      }),
      expect.objectContaining({
        id: 'stable-folder',
        name: 'Renamed folder',
        source: expect.objectContaining({
          path: 'Proxima/projects/Folder/index.md',
          kind: 'project',
          idOrigin: 'frontmatter',
        }),
      }),
    ]));
  });

  it('uses body as the description only when description is absent, and preserves an explicit empty value', async () => {
    const { state } = await loadVaultState(
      createMemoryVault({
        'Proxima/projects/Absent.md': project('name: Absent', 'Body fallback'),
        'Proxima/projects/Present.md': project('name: Present\ndescription: Frontmatter wins', 'Body loses'),
        'Proxima/projects/Empty.md': project('name: Empty\ndescription:', 'Body is suppressed'),
      }),
    );
    expect(state.projects.map(({ id, description }) => ({ id, description }))).toEqual([
      { id: 'Absent', description: 'Body fallback' },
      { id: 'Empty', description: '' },
      { id: 'Present', description: 'Frontmatter wins' },
    ]);
  });

  it('accepts preferred arrays and legacy scalar linked-folder encodings with exact-path deduplication', async () => {
    const { state } = await loadVaultState(
      createMemoryVault({
        'Proxima/projects/Links.md': project(
          'linkedFolder: Drawings\nlinkedFolders: [Drawings, Notes, Art|Drawings/Art, Art duplicate|Drawings/Art]',
        ),
        'Proxima/projects/Packed.md': project(
          'linkedFolders: Art|Drawings/Art;References|Refs/Studio;Again|Refs/Studio',
        ),
      }),
    );
    expect(state.projects.find((record) => record.id === 'Links')?.linkedFolders).toEqual([
      { name: 'Drawings', path: 'Drawings' },
      { name: 'Notes', path: 'Notes' },
      { name: 'Art', path: 'Drawings/Art' },
    ]);
    expect(state.projects.find((record) => record.id === 'Packed')?.linkedFolders).toEqual([
      { name: 'Art', path: 'Drawings/Art' },
      { name: 'References', path: 'Refs/Studio' },
    ]);
  });

  it('retains archived projects as records with their status and provenance', async () => {
    const { state } = await loadVaultState(
      createMemoryVault({
        'Proxima/projects/Old.md': project('id: old-project\nname: Old\nstatus: archived'),
      }),
    );
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({
      id: 'old-project',
      name: 'Old',
      status: 'archived',
      source: { path: 'Proxima/projects/Old.md', kind: 'project' },
    });
  });
});
