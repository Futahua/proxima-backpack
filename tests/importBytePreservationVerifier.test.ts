import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  type LegacyImportArtifactIdentityAllocator,
} from '../src/app/importArtifactPlanner.js';
import {
  runLegacyImportBytePreservationProof,
} from '../src/app/importBytePreservationVerifier.js';
import {
  planLegacyMarkdownImport,
  type LegacyImportIdentityAllocator,
} from '../src/app/importPlanner.js';
import {
  materializeLegacyImportProjectStaging,
} from '../src/app/importProjectStagingPlanner.js';
import {
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import {
  parseOpaqueExternalArtifactId,
} from '../src/domain/canonicalArtifactAssociation.js';
import {
  encodeCanonicalRecordV2,
  type CanonicalRecordV2,
} from '../src/domain/canonicalRecordV2.js';
import type {
  OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import type {
  DirectoryPresence,
  VaultBinaryFile,
  VaultEntry,
  VaultFile,
  VaultReader,
} from '../src/ports/vault.js';

function opaqueRecordId(
  value:
    number,
): string {
  return `pxr_${value
    .toString(16)
    .padStart(
      32,
      '0',
    )}`;
}

function sequentialRecordAllocator():
  LegacyImportIdentityAllocator {
  let next =
    1;

  return {
    recordIdFor() {
      const id =
        opaqueRecordId(
          next,
        );

      next +=
        1;

      return id;
    },
  };
}

function sequentialArtifactAllocator():
  LegacyImportArtifactIdentityAllocator {
  let next =
    1;

  return {
    artifactIdFor() {
      const id =
        parseOpaqueExternalArtifactId(
          `pxa_${next
            .toString(16)
            .padStart(
              32,
              '0',
            )}`,
        );

      next +=
        1;

      return id;
    },
  };
}

class BinaryMemoryVault
implements VaultReader {
  private readonly files =
    new Map<
      string,
      Uint8Array
    >();

  private readonly revisions =
    new Map<
      string,
      number
    >();

  constructor(
    files:
      Record<
        string,
        string | Uint8Array
      >,
  ) {
    for (
      const [
        path,
        value,
      ]
      of Object.entries(
        files,
      )
    ) {
      const key =
        this.normalise(
          path,
        );

      const bytes =
        typeof value
          === 'string'
          ? new TextEncoder()
              .encode(
                value,
              )
          : new Uint8Array(
              value,
            );

      this.files.set(
        key,
        bytes,
      );

      this.revisions.set(
        key,
        1,
      );
    }
  }

  private normalise(
    path:
      string,
  ): string {
    return path
      .split(
        String.fromCharCode(
          92,
        ),
      )
      .join(
        '/',
      )
      .replace(
        /^[/]+|[/]+$/g,
        '',
      );
  }

  async list(
    directory:
      string,
  ): Promise<
    VaultEntry[]
  > {
    const prefix =
      this.normalise(
        directory,
      );

    const base =
      prefix
        ? `${prefix}/`
        : '';

    const seen =
      new Map<
        string,
        VaultEntry
      >();

    for (
      const path
      of this.files
        .keys()
    ) {
      if (
        !path.startsWith(
          base,
        )
      ) {
        continue;
      }

      const rest =
        path.slice(
          base.length,
        );

      if (
        rest.length
        === 0
      ) {
        continue;
      }

      const slash =
        rest.indexOf(
          '/',
        );

      if (
        slash
        === -1
      ) {
        seen.set(
          path,
          {
            path,
            kind:
              'file',
          },
        );
      } else {
        const child =
          `${base}${rest.slice(
            0,
            slash,
          )}`;

        seen.set(
          child,
          {
            path:
              child,
            kind:
              'directory',
          },
        );
      }
    }

    return [
      ...seen
        .values(),
    ].sort(
      (
        left,
        right,
      ) =>
        left.path
          .localeCompare(
            right.path,
          ),
    );
  }

  async read(
    path:
      string,
    maxChars?:
      number,
  ): Promise<
    VaultFile
  > {
    const key =
      this.normalise(
        path,
      );

    const bytes =
      this.files.get(
        key,
      );

    if (
      bytes
      === undefined
    ) {
      throw new Error(
        `No such test vault file: ${key}`,
      );
    }

    const text =
      new TextDecoder()
        .decode(
          bytes,
        );

    if (
      maxChars
      !== undefined
      && text.length
        > maxChars
    ) {
      throw new Error(
        'Test vault text bound exceeded.',
      );
    }

    return {
      path:
        key,
      text,
      revision:
        `${key}@${this.revisions.get(
          key,
        ) ?? 1}`,
      size:
        bytes.byteLength,
      modifiedAt:
        new Date(
          0,
        ).toISOString(),
    };
  }

  async readBinary(
    path:
      string,
    maxBytes:
      number,
  ): Promise<
    VaultBinaryFile
  > {
    const key =
      this.normalise(
        path,
      );

    const bytes =
      this.files.get(
        key,
      );

    if (
      bytes
      === undefined
    ) {
      throw new Error(
        `No such test vault file: ${key}`,
      );
    }

    if (
      bytes.byteLength
      > maxBytes
    ) {
      throw new Error(
        'Test vault binary bound exceeded.',
      );
    }

    return {
      path:
        key,
      bytes:
        new Uint8Array(
          bytes,
        ),
      size:
        bytes.byteLength,
      revision:
        `${key}@${this.revisions.get(
          key,
        ) ?? 1}`,
      modifiedAt:
        new Date(
          0,
        ).toISOString(),
    };
  }

  async exists(
    path:
      string,
  ): Promise<
    boolean
  > {
    const key =
      this.normalise(
        path,
      );

    return this.files.has(
      key,
    )
      || [
          ...this.files
            .keys(),
        ].some(
          (candidate) =>
            candidate.startsWith(
              `${key}/`,
            ),
        );
  }

  async walk(
    directory:
      string,
  ): Promise<
    string[]
  > {
    const prefix =
      this.normalise(
        directory,
      );

    const base =
      prefix
        ? `${prefix}/`
        : '';

    return [
      ...this.files
        .keys(),
    ]
      .filter(
        (path) =>
          path.startsWith(
            base,
          ),
      )
      .sort();
  }

  async presence(
    directory:
      string,
  ): Promise<
    DirectoryPresence
  > {
    return await this.exists(
      directory,
    )
      ? 'present'
      : 'missing';
  }

  setText(
    path:
      string,
    text:
      string,
  ): void {
    this.setBytes(
      path,
      new TextEncoder()
        .encode(
          text,
        ),
    );
  }

  setBytes(
    path:
      string,
    bytes:
      Uint8Array,
  ): void {
    const key =
      this.normalise(
        path,
      );

    this.files.set(
      key,
      new Uint8Array(
        bytes,
      ),
    );

    this.revisions.set(
      key,
      (
        this.revisions.get(
          key,
        )
        ?? 0
      ) + 1,
    );
  }

  delete(
    path:
      string,
  ): void {
    const key =
      this.normalise(
        path,
      );

    this.files.delete(
      key,
    );

    this.revisions.delete(
      key,
    );
  }
}

class MemoryStagingStore
implements LegacyImportStagingStore {
  readonly authority =
    'legacy-import-staging-only' as const;

  private readonly records =
    new Map<
      OpaqueRecordId,
      CanonicalRecordV2
    >();

  async readStagedRecord(
    recordId:
      OpaqueRecordId,
  ): Promise<
    CanonicalRecordV2 | null
  > {
    return this.records.get(
      recordId,
    )
      ?? null;
  }

  async createStagedRecord(
    record:
      CanonicalRecordV2,
  ): Promise<
    LegacyImportStagingCreateResult
  > {
    if (
      this.records.has(
        record.id,
      )
    ) {
      return {
        ok: false,
        reason:
          'already-exists',
      };
    }

    this.records.set(
      record.id,
      encodeCanonicalRecordV2(
        record,
      ),
    );

    return {
      ok: true,
    };
  }
}

async function plan(
  vault:
    VaultReader,
  withArtifacts =
    true,
) {
  return planLegacyMarkdownImport(
    vault,
    sequentialRecordAllocator(),
    {},
    null,
    null,
    withArtifacts
      ? {
          allocator:
            sequentialArtifactAllocator(),
        }
      : null,
  );
}

const MAX_TEST_FILE_BYTES =
  1_000_000;

describe(
  'Stage 8 slice 16 import byte-preservation proof',
  () => {
    it(
      'hashes legacy Markdown and vault-relative external artifact bytes before and after a real staging operation and proves they are unchanged',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'name: Alpha',
              'linkedFolders: Attachments|Attachments/Alpha',
              '---',
              '',
            ].join(
              '\n',
            ),
            'Attachments/Alpha/blob.bin':
              new Uint8Array([
                0,
                255,
                1,
                2,
                3,
              ]),
          });

        const importPlan =
          await plan(
            vault,
          );

        const staging =
          new MemoryStagingStore();

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () =>
              materializeLegacyImportProjectStaging(
                importPlan,
                staging,
              ),
          );

        expect(result)
          .toMatchObject({
            schemaVersion: 1,
            mode:
              'verification',
            source:
              'legacy-import-vault-byte-snapshot',
            algorithm:
              'SHA-256',
            verdict:
              'preserved',
            counts: {
              legacyMarkdownBefore: 1,
              legacyMarkdownAfter: 1,
              vaultExternalFilesBefore: 1,
              vaultExternalFilesAfter: 1,
              machineArtifactReferences: 0,
              changedPaths: 0,
            },
            verifierWrites: {
              legacyMarkdown: 0,
              recordStore: 0,
              externalArtifacts: 0,
              activation: 0,
            },
            operationResult: {
              counts: {
                created: 1,
                blocked: 0,
              },
            },
          });

        expect(
          result.changes,
        ).toEqual([]);

        expect(
          result.before.entries,
        ).toEqual(
          result.after.entries,
        );

        expect(
          result.before.entries.every(
            (entry) =>
              entry.sha256.length
              === 64,
          ),
        ).toBe(
          true,
        );
      },
    );

    it(
      'detects byte changes to an existing legacy Markdown record',
      async () => {
        const original = [
          '---',
          'id: alpha',
          'type: project',
          'name: Alpha',
          '---',
          '',
        ].join(
          '\n',
        );

        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md':
              original,
          });

        const importPlan =
          await plan(
            vault,
          );

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () => {
              vault.setText(
                'Proxima/projects/alpha.md',
                `${original}injected`,
              );
            },
          );

        expect(
          result.verdict,
        ).toBe(
          'changed',
        );

        expect(result.changes)
          .toEqual([
            expect.objectContaining({
              scope:
                'legacy-markdown',
              path:
                'Proxima/projects/alpha.md',
              disposition:
                'changed',
            }),
          ]);
      },
    );

    it(
      'detects a newly injected Markdown source file instead of allowing source promotion to disappear from the proof',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const importPlan =
          await plan(
            vault,
          );

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () => {
              vault.setText(
                'Proxima/tasks/injected.md',
                [
                  '---',
                  'id: injected',
                  '---',
                  '',
                ].join(
                  '\n',
                ),
              );
            },
          );

        expect(
          result.verdict,
        ).toBe(
          'changed',
        );

        expect(result.changes)
          .toEqual([
            expect.objectContaining({
              scope:
                'legacy-markdown',
              path:
                'Proxima/tasks/injected.md',
              disposition:
                'added',
              beforeSha256:
                null,
            }),
          ]);
      },
    );

    it(
      'detects removal of a legacy Markdown source file',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const importPlan =
          await plan(
            vault,
          );

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () => {
              vault.delete(
                'Proxima/projects/alpha.md',
              );
            },
          );

        expect(
          result.verdict,
        ).toBe(
          'changed',
        );

        expect(result.changes)
          .toEqual([
            expect.objectContaining({
              scope:
                'legacy-markdown',
              path:
                'Proxima/projects/alpha.md',
              disposition:
                'removed',
              afterSha256:
                null,
            }),
          ]);
      },
    );

    it(
      'detects binary changes beneath a vault-relative linked artifact folder',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'linkedFolders: Attachments|Attachments/Alpha',
              '---',
              '',
            ].join(
              '\n',
            ),
            'Attachments/Alpha/blob.bin':
              new Uint8Array([
                0,
                1,
                2,
                3,
              ]),
          });

        const importPlan =
          await plan(
            vault,
          );

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () => {
              vault.setBytes(
                'Attachments/Alpha/blob.bin',
                new Uint8Array([
                  0,
                  1,
                  2,
                  4,
                ]),
              );
            },
          );

        expect(
          result.verdict,
        ).toBe(
          'changed',
        );

        expect(result.changes)
          .toEqual([
            expect.objectContaining({
              scope:
                'vault-relative-external-artifact',
              path:
                'Attachments/Alpha/blob.bin',
              disposition:
                'changed',
            }),
          ]);
      },
    );

    it(
      'reports machine-path artifact references as unverifiable through the vault reader instead of claiming their bytes were proven unchanged',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              'linkedFolders: Docs|C:\\Creator\\Docs',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const importPlan =
          await plan(
            vault,
          );

        const result =
          await runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () =>
              'no-op',
          );

        expect(
          result.verdict,
        ).toBe(
          'unverifiable-machine-artifacts',
        );

        expect(
          result.changes,
        ).toEqual([]);

        expect(
          result.counts
            .machineArtifactReferences,
        ).toBe(
          1,
        );

        expect(
          result.before
            .machineArtifactReferences,
        ).toEqual([
          {
            artifactId:
              parseOpaqueExternalArtifactId(
                'pxa_00000000000000000000000000000001',
              ),
            path:
              'C:\\Creator\\Docs',
          },
        ]);
      },
    );

    it(
      'refuses to claim byte preservation when the accepted external-artifact plan is absent',
      async () => {
        const vault =
          new BinaryMemoryVault({
            'Proxima/projects/alpha.md': [
              '---',
              'id: alpha',
              'type: project',
              '---',
              '',
            ].join(
              '\n',
            ),
          });

        const importPlan =
          await plan(
            vault,
            false,
          );

        let operationRan =
          false;

        await expect(
          runLegacyImportBytePreservationProof(
            vault,
            importPlan,
            {},
            MAX_TEST_FILE_BYTES,
            async () => {
              operationRan =
                true;
            },
          ),
        ).rejects.toThrow(
          /needs the accepted external-artifact plan/,
        );

        expect(
          operationRan,
        ).toBe(
          false,
        );
      },
    );
  },
);
