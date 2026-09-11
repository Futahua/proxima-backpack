import type {
  RecordKind,
} from '../domain/records.js';
import type {
  VaultReader,
} from '../ports/vault.js';
import type {
  LegacyImportPlan,
} from './importPlanner.js';
import type {
  LoadOptions,
} from './vaultRepository.js';
import {
  directoryFor,
  resolveLayout,
} from './vaultLayout.js';

export const LEGACY_IMPORT_BYTE_PRESERVATION_PROOF_SCHEMA_VERSION =
  1 as const;

const RECORD_KINDS:
  readonly RecordKind[] = [
    'project',
    'task',
    'event',
  ];

export type LegacyImportBytePreservationScope =
  | 'legacy-markdown'
  | 'vault-relative-external-artifact';

export interface LegacyImportByteDigest {
  readonly scope:
    LegacyImportBytePreservationScope;
  readonly path:
    string;
  readonly size:
    number;
  readonly sha256:
    string;
}

export interface LegacyImportMachineArtifactReference {
  readonly artifactId:
    string;
  readonly path:
    string;
}

export interface LegacyImportBytePreservationSnapshot {
  readonly algorithm:
    'SHA-256';
  readonly entries:
    readonly LegacyImportByteDigest[];
  readonly machineArtifactReferences:
    readonly LegacyImportMachineArtifactReference[];
}

export interface LegacyImportBytePreservationChange {
  readonly scope:
    LegacyImportBytePreservationScope;
  readonly path:
    string;
  readonly disposition:
    | 'added'
    | 'removed'
    | 'changed';
  readonly beforeSha256:
    string | null;
  readonly afterSha256:
    string | null;
}

export interface LegacyImportBytePreservationProof<
  OperationResult,
> {
  readonly schemaVersion:
    typeof LEGACY_IMPORT_BYTE_PRESERVATION_PROOF_SCHEMA_VERSION;
  readonly mode:
    'verification';
  readonly source:
    'legacy-import-vault-byte-snapshot';
  readonly algorithm:
    'SHA-256';
  readonly verdict:
    | 'preserved'
    | 'changed'
    | 'unverifiable-machine-artifacts';

  readonly before:
    LegacyImportBytePreservationSnapshot;
  readonly after:
    LegacyImportBytePreservationSnapshot;

  readonly changes:
    readonly LegacyImportBytePreservationChange[];

  readonly operationResult:
    OperationResult;

  readonly counts: {
    readonly legacyMarkdownBefore:
      number;
    readonly legacyMarkdownAfter:
      number;
    readonly vaultExternalFilesBefore:
      number;
    readonly vaultExternalFilesAfter:
      number;
    readonly machineArtifactReferences:
      number;
    readonly changedPaths:
      number;
  };

  readonly verifierWrites: {
    readonly legacyMarkdown:
      0;
    readonly recordStore:
      0;
    readonly externalArtifacts:
      0;
    readonly activation:
      0;
  };
}

interface SnapshotPaths {
  readonly legacyMarkdown:
    readonly string[];
  readonly vaultExternalFiles:
    readonly string[];
  readonly machineArtifactReferences:
    readonly LegacyImportMachineArtifactReference[];
}

function pathKey(
  scope:
    LegacyImportBytePreservationScope,
  path:
    string,
): string {
  return `${scope}\u0000${path}`;
}

function compareDigest(
  left:
    LegacyImportByteDigest,
  right:
    LegacyImportByteDigest,
): number {
  return left.scope
    .localeCompare(
      right.scope,
    )
    || left.path
      .localeCompare(
        right.path,
      );
}

function compareMachineReference(
  left:
    LegacyImportMachineArtifactReference,
  right:
    LegacyImportMachineArtifactReference,
): number {
  return left.path
    .localeCompare(
      right.path,
    )
    || left.artifactId
      .localeCompare(
        right.artifactId,
      );
}

async function walkKnownDirectory(
  vault:
    VaultReader,
  directory:
    string,
): Promise<
  string[]
> {
  try {
    return await vault.walk(
      directory,
    );
  } catch (error) {
    if (
      vault.presence
      !== undefined
    ) {
      let presence:
        Awaited<
          ReturnType<
            NonNullable<
              VaultReader['presence']
            >
          >
        >;

      try {
        presence =
          await vault.presence(
            directory,
          );
      } catch {
        presence =
          'unknown';
      }

      if (
        presence
        === 'missing'
      ) {
        return [];
      }
    }

    throw error;
  }
}

async function snapshotPaths(
  vault:
    VaultReader,
  plan:
    LegacyImportPlan,
  options:
    LoadOptions,
): Promise<
  SnapshotPaths
> {
  const layout =
    resolveLayout(
      options,
    );

  const legacyMarkdown =
    new Set<
      string
    >();

  for (
    const kind
    of RECORD_KINDS
  ) {
    const directory =
      directoryFor(
        layout,
        kind,
      );

    const paths =
      await walkKnownDirectory(
        vault,
        directory,
      );

    for (
      const path
      of paths
    ) {
      if (
        path
          .toLowerCase()
          .endsWith(
            '.md',
          )
      ) {
        legacyMarkdown.add(
          path,
        );
      }
    }
  }

  if (
    plan.externalArtifacts
    === null
  ) {
    throw new Error(
      'Byte-preservation proof needs the accepted external-artifact plan.',
    );
  }

  const externalRoots =
    new Set<
      string
    >();

  const machineArtifactReferences:
    LegacyImportMachineArtifactReference[] =
      [];

  for (
    const reference
    of plan.externalArtifacts
      .references
  ) {
    if (
      reference.kind
      !== 'folder'
    ) {
      throw new Error(
        `Byte-preservation proof received non-folder external artifact ${reference.id}.`,
      );
    }

    if (
      reference.locator.kind
      === 'machine-path'
    ) {
      machineArtifactReferences.push({
        artifactId:
          reference.id,
        path:
          reference.locator
            .path,
      });

      continue;
    }

    externalRoots.add(
      reference.locator
        .path,
    );
  }

  const vaultExternalFiles =
    new Set<
      string
    >();

  for (
    const root
    of [
      ...externalRoots,
    ].sort()
  ) {
    const paths =
      await walkKnownDirectory(
        vault,
        root,
      );

    for (
      const path
      of paths
    ) {
      vaultExternalFiles.add(
        path,
      );
    }
  }

  return {
    legacyMarkdown:
      [
        ...legacyMarkdown,
      ].sort(),
    vaultExternalFiles:
      [
        ...vaultExternalFiles,
      ].sort(),
    machineArtifactReferences:
      machineArtifactReferences
        .sort(
          compareMachineReference,
        ),
  };
}

async function sha256(
  bytes:
    Uint8Array,
): Promise<
  string
> {
  const subtle =
    globalThis.crypto
      ?.subtle;

  if (
    subtle
    === undefined
  ) {
    throw new Error(
      'Byte-preservation proof cannot access SHA-256 digest capability.',
    );
  }

  const copy =
    new Uint8Array(
      bytes.byteLength,
    );

  copy.set(
    bytes,
  );

  const digest =
    await subtle.digest(
      'SHA-256',
      copy,
    );

  return Array.from(
    new Uint8Array(
      digest,
    ),
    (byte) =>
      byte
        .toString(
          16,
        )
        .padStart(
          2,
          '0',
        ),
  ).join('');
}

async function digestPath(
  vault:
    VaultReader,
  scope:
    LegacyImportBytePreservationScope,
  path:
    string,
  maxBytesPerFile:
    number,
): Promise<
  LegacyImportByteDigest
> {
  const binaryRead =
    vault.readBinary;

  if (
    binaryRead
    === undefined
  ) {
    throw new Error(
      'Byte-preservation proof needs binary vault reads.',
    );
  }

  const file =
    await binaryRead.call(
      vault,
      path,
      maxBytesPerFile,
    );

  return {
    scope,
    path,
    size:
      file.bytes
        .byteLength,
    sha256:
      await sha256(
        file.bytes,
      ),
  };
}

async function captureSnapshot(
  vault:
    VaultReader,
  plan:
    LegacyImportPlan,
  options:
    LoadOptions,
  maxBytesPerFile:
    number,
): Promise<
  LegacyImportBytePreservationSnapshot
> {
  if (
    !Number.isSafeInteger(
      maxBytesPerFile,
    )
    || maxBytesPerFile
      < 1
  ) {
    throw new Error(
      'Byte-preservation proof maxBytesPerFile must be a positive safe integer.',
    );
  }

  const paths =
    await snapshotPaths(
      vault,
      plan,
      options,
    );

  const entries:
    LegacyImportByteDigest[] =
      [];

  for (
    const path
    of paths.legacyMarkdown
  ) {
    entries.push(
      await digestPath(
        vault,
        'legacy-markdown',
        path,
        maxBytesPerFile,
      ),
    );
  }

  for (
    const path
    of paths.vaultExternalFiles
  ) {
    entries.push(
      await digestPath(
        vault,
        'vault-relative-external-artifact',
        path,
        maxBytesPerFile,
      ),
    );
  }

  entries.sort(
    compareDigest,
  );

  return {
    algorithm:
      'SHA-256',
    entries,
    machineArtifactReferences:
      paths
        .machineArtifactReferences,
  };
}

function compareSnapshots(
  before:
    LegacyImportBytePreservationSnapshot,
  after:
    LegacyImportBytePreservationSnapshot,
): LegacyImportBytePreservationChange[] {
  const beforeByPath =
    new Map<
      string,
      LegacyImportByteDigest
    >();

  const afterByPath =
    new Map<
      string,
      LegacyImportByteDigest
    >();

  for (
    const entry
    of before.entries
  ) {
    beforeByPath.set(
      pathKey(
        entry.scope,
        entry.path,
      ),
      entry,
    );
  }

  for (
    const entry
    of after.entries
  ) {
    afterByPath.set(
      pathKey(
        entry.scope,
        entry.path,
      ),
      entry,
    );
  }

  const keys =
    [
      ...new Set([
        ...beforeByPath
          .keys(),
        ...afterByPath
          .keys(),
      ]),
    ].sort();

  const changes:
    LegacyImportBytePreservationChange[] =
      [];

  for (
    const key
    of keys
  ) {
    const beforeEntry =
      beforeByPath.get(
        key,
      );

    const afterEntry =
      afterByPath.get(
        key,
      );

    if (
      beforeEntry
      === undefined
      && afterEntry
        !== undefined
    ) {
      changes.push({
        scope:
          afterEntry.scope,
        path:
          afterEntry.path,
        disposition:
          'added',
        beforeSha256:
          null,
        afterSha256:
          afterEntry.sha256,
      });

      continue;
    }

    if (
      beforeEntry
      !== undefined
      && afterEntry
        === undefined
    ) {
      changes.push({
        scope:
          beforeEntry.scope,
        path:
          beforeEntry.path,
        disposition:
          'removed',
        beforeSha256:
          beforeEntry.sha256,
        afterSha256:
          null,
      });

      continue;
    }

    if (
      beforeEntry
      === undefined
      || afterEntry
        === undefined
    ) {
      throw new Error(
        'Byte-preservation proof lost snapshot comparison evidence.',
      );
    }

    if (
      beforeEntry.sha256
        !== afterEntry.sha256
      || beforeEntry.size
        !== afterEntry.size
    ) {
      changes.push({
        scope:
          beforeEntry.scope,
        path:
          beforeEntry.path,
        disposition:
          'changed',
        beforeSha256:
          beforeEntry.sha256,
        afterSha256:
          afterEntry.sha256,
      });
    }
  }

  return changes;
}

function countScope(
  snapshot:
    LegacyImportBytePreservationSnapshot,
  scope:
    LegacyImportBytePreservationScope,
): number {
  return snapshot.entries
    .filter(
      (entry) =>
        entry.scope
        === scope,
    )
    .length;
}

/**
 * Capture exact binary hashes, execute one supplied import/staging operation,
 * and capture the same configured legacy/external source surfaces afterward.
 *
 * This verifier receives no VaultWriter and has no Record Store or activation
 * authority. The supplied operation remains responsible for its own bounded
 * authority; this function only observes whether creator/source bytes changed.
 */
export async function runLegacyImportBytePreservationProof<
  OperationResult,
>(
  vault:
    VaultReader,
  plan:
    LegacyImportPlan,
  options:
    LoadOptions,
  maxBytesPerFile:
    number,
  operation:
    () => Promise<
      OperationResult
    >,
): Promise<
  LegacyImportBytePreservationProof<
    OperationResult
  >
> {
  const before =
    await captureSnapshot(
      vault,
      plan,
      options,
      maxBytesPerFile,
    );

  const operationResult =
    await operation();

  const after =
    await captureSnapshot(
      vault,
      plan,
      options,
      maxBytesPerFile,
    );

  const changes =
    compareSnapshots(
      before,
      after,
    );

  const machineArtifactReferences =
    before
      .machineArtifactReferences;

  const verdict:
    LegacyImportBytePreservationProof<
      OperationResult
    >['verdict'] =
      changes.length
      > 0
        ? 'changed'
        : machineArtifactReferences
            .length
          > 0
          ? 'unverifiable-machine-artifacts'
          : 'preserved';

  return {
    schemaVersion:
      LEGACY_IMPORT_BYTE_PRESERVATION_PROOF_SCHEMA_VERSION,
    mode:
      'verification',
    source:
      'legacy-import-vault-byte-snapshot',
    algorithm:
      'SHA-256',
    verdict,

    before,
    after,
    changes,

    operationResult,

    counts: {
      legacyMarkdownBefore:
        countScope(
          before,
          'legacy-markdown',
        ),
      legacyMarkdownAfter:
        countScope(
          after,
          'legacy-markdown',
        ),
      vaultExternalFilesBefore:
        countScope(
          before,
          'vault-relative-external-artifact',
        ),
      vaultExternalFilesAfter:
        countScope(
          after,
          'vault-relative-external-artifact',
        ),
      machineArtifactReferences:
        machineArtifactReferences
          .length,
      changedPaths:
        changes.length,
    },

    verifierWrites: {
      legacyMarkdown: 0,
      recordStore: 0,
      externalArtifacts: 0,
      activation: 0,
    },
  };
}
