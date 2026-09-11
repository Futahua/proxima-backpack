/**
 * Stage 8's byte-preservation proof, run against a real tree on disk.
 *
 * The existing verifier suite hashes a binary memory vault. That proves the comparison
 * logic; it does not prove that running the importer over real files leaves the files
 * alone, because a memory vault cannot be inspected behind the reader's back. This file
 * copies a real fixture vault to a disposable root, hashes every byte with `node:crypto`
 * before and after a real staging run for every record kind, and asserts three things at
 * once: the verifier's verdict is `preserved`, the verifier's own digests agree with the
 * filesystem's independent hashes, and the operation actually staged records rather than
 * doing nothing.
 *
 * The vault is a copy in the system temp directory. Nothing here touches `fixtures/` or
 * any creator data, and no writer is ever handed to the proof.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LegacyImportArtifactIdentityAllocator } from '../src/app/importArtifactPlanner.js';
import { runLegacyImportBytePreservationProof } from '../src/app/importBytePreservationVerifier.js';
import { materializeLegacyImportEventStaging } from '../src/app/importEventStagingPlanner.js';
import { planLegacyMarkdownImport, type LegacyImportIdentityAllocator } from '../src/app/importPlanner.js';
import { materializeLegacyImportProjectStaging } from '../src/app/importProjectStagingPlanner.js';
import {
  materializeLegacyImportSchemaStaging,
  type LegacyImportStagingCreateResult,
  type LegacyImportStagingStore,
} from '../src/app/importStagingPlanner.js';
import type { LegacyImportSchemaIdentityAllocator } from '../src/app/importSchemaPlanner.js';
import { materializeLegacyImportTaskStaging } from '../src/app/importTaskStagingPlanner.js';
import {
  materializeLegacyImportWorkflowStageStaging,
  type LegacyImportWorkflowStageIdentityAllocator,
  type LegacyImportWorkflowStageIdentityMappingManifest,
  type LegacyImportWorkflowStageIdentityMappingStore,
} from '../src/app/importWorkflowStageStagingPlanner.js';
import { parseOpaqueExternalArtifactId } from '../src/domain/canonicalArtifactAssociation.js';
import type { OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { encodeCanonicalRecordV2, type CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { copyFixtureToDisk, createDiskVault, removeDiskFixture } from './test-disk-vault.js';
import { fixtureFiles } from './fixtures.js';

const MAX_TEST_FILE_BYTES = 1_000_000;

function opaqueRecordId(value: number): string {
  return `pxr_${value.toString(16).padStart(32, '0')}`;
}

function opaqueArtifactId(value: number): string {
  return `pxa_${value.toString(16).padStart(32, '0')}`;
}

function sequentialRecordAllocator(): LegacyImportIdentityAllocator {
  let next = 1;
  return {
    recordIdFor() {
      const id = opaqueRecordId(next);
      next += 1;
      return id;
    },
  };
}

function sequentialArtifactAllocator(): LegacyImportArtifactIdentityAllocator {
  let next = 1;
  return {
    artifactIdFor() {
      const id = parseOpaqueExternalArtifactId(opaqueArtifactId(next));
      next += 1;
      return id;
    },
  };
}

function sequentialWorkflowStageAllocator(): LegacyImportWorkflowStageIdentityAllocator {
  let next = 100;
  return {
    workflowStageRecordIdFor() {
      const value = opaqueRecordId(next);
      next += 1;
      return value;
    },
  };
}

function sequentialSchemaAllocator(): LegacyImportSchemaIdentityAllocator {
  let nextRecord = 100;
  let nextOption = 1;
  return {
    schemaRecordIdFor() {
      const id = opaqueRecordId(nextRecord);
      nextRecord += 1;
      return id;
    },
    schemaOptionIdFor() {
      const id = opaqueRecordId(1_000 + nextOption);
      nextOption += 1;
      return id;
    },
  };
}

/**
 * The legacy settings a creator's vault would have declared. The fixture vaults carry no
 * custom properties, so the snapshot is empty on purpose: the point of passing one is that
 * the property-value plan exists at all, and a task carrying a property this snapshot does
 * not declare is blocked rather than guessed.
 */
const EMPTY_LEGACY_SCHEMA_SNAPSHOT = {
  taskSchema: [],
  projectSchemas: {},
};

class MemoryStagingStore implements LegacyImportStagingStore {
  readonly authority = 'legacy-import-staging-only' as const;

  readonly records = new Map<OpaqueRecordId, CanonicalRecordV2>();

  async readStagedRecord(recordId: OpaqueRecordId): Promise<CanonicalRecordV2 | null> {
    return this.records.get(recordId) ?? null;
  }

  async createStagedRecord(record: CanonicalRecordV2): Promise<LegacyImportStagingCreateResult> {
    if (this.records.has(record.id)) return { ok: false, reason: 'already-exists' };
    this.records.set(record.id, encodeCanonicalRecordV2(record));
    return { ok: true };
  }
}

class MemoryWorkflowStageIdentityStore implements LegacyImportWorkflowStageIdentityMappingStore {
  private mapping: LegacyImportWorkflowStageIdentityMappingManifest | null = null;

  async load(): Promise<LegacyImportWorkflowStageIdentityMappingManifest | null> {
    return this.mapping === null ? null : JSON.parse(JSON.stringify(this.mapping)) as LegacyImportWorkflowStageIdentityMappingManifest;
  }

  async save(mapping: LegacyImportWorkflowStageIdentityMappingManifest): Promise<void> {
    this.mapping = JSON.parse(JSON.stringify(mapping)) as LegacyImportWorkflowStageIdentityMappingManifest;
  }
}

/** Every file under a directory, vault-relative and forward-slashed. */
async function treePaths(root: string, directory = ''): Promise<string[]> {
  const absolute = directory === '' ? root : join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await treePaths(root, path));
    else paths.push(path);
  }
  return paths;
}

/** The filesystem's own account of every byte in the tree, for comparison against the verifier's. */
async function diskDigests(root: string): Promise<Map<string, { sha256: string; size: number }>> {
  const digests = new Map<string, { sha256: string; size: number }>();
  for (const path of await treePaths(root)) {
    const bytes = new Uint8Array(await readFile(join(root, ...path.split('/'))));
    digests.set(path, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    });
  }
  return digests;
}

function changedBetween(
  before: Map<string, { sha256: string; size: number }>,
  after: Map<string, { sha256: string; size: number }>,
): string[] {
  const changed: string[] = [];
  for (const [path, digest] of before) {
    const next = after.get(path);
    if (next === undefined || next.sha256 !== digest.sha256) changed.push(path);
  }
  for (const path of after.keys()) if (!before.has(path)) changed.push(path);
  return changed.sort();
}

async function disposableFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `proxima-import-${name}-`));
  await copyFixtureToDisk(fixtureFiles(name), root);
  return root;
}

/**
 * The real staging operation, in the order the planners require: projects first, then the
 * workflow stages the projects scope, then the tasks that resolve their stage through that
 * mapping, then events and the schema records the plan declares.
 */
async function stageEverything(plan: Awaited<ReturnType<typeof planLegacyMarkdownImport>>, staging: MemoryStagingStore) {
  const projects = await materializeLegacyImportProjectStaging(plan, staging);
  const workflowStages = await materializeLegacyImportWorkflowStageStaging(
    plan,
    staging,
    sequentialWorkflowStageAllocator(),
    new MemoryWorkflowStageIdentityStore(),
  );
  const tasks = await materializeLegacyImportTaskStaging(plan, staging, workflowStages.identityMapping);
  const events = await materializeLegacyImportEventStaging(plan, staging);
  const schema = await materializeLegacyImportSchemaStaging(plan, staging);
  return { projects, workflowStages, tasks, events, schema };
}

describe('Stage 8 import staging against a real tree', () => {
  it('stages every record kind on a disposable copy of a fixture vault and leaves every byte of it alone', async () => {
    const root = await disposableFixture('vault-basic');
    try {
      // The fixture's project declares `linkedFolders: [Drawings, Notes]` and the fixtures
      // carry no non-Markdown files, so the artifact half of the proof needs real ones.
      await mkdir(join(root, 'Drawings'), { recursive: true });
      await mkdir(join(root, 'Notes'), { recursive: true });
      await writeFile(join(root, 'Notes', 'standup.md'), '# Standup\n\nA note the importer must not copy or touch.\n');
      await writeFile(join(root, 'Drawings', 'knowledge.canvas'), '{"nodes":[],"edges":[]}\n');
      await writeFile(join(root, 'Notes', 'attachment.bin'), new Uint8Array([0, 255, 1, 2, 3, 254]));

      const vault = createDiskVault(root);
      const importPlan = await planLegacyMarkdownImport(
        vault,
        sequentialRecordAllocator(),
        {},
        null,
        { snapshot: EMPTY_LEGACY_SCHEMA_SNAPSHOT, allocator: sequentialSchemaAllocator() },
        { allocator: sequentialArtifactAllocator() },
      );
      const before = await diskDigests(root);
      const staging = new MemoryStagingStore();

      const proof = await runLegacyImportBytePreservationProof(
        vault,
        importPlan,
        {},
        MAX_TEST_FILE_BYTES,
        async () => stageEverything(importPlan, staging),
      );

      const after = await diskDigests(root);

      // The verdict, and the fact that the operation did something: a proof over a no-op
      // would be worthless.
      expect(proof.verdict).toBe('preserved');
      expect(proof.changes).toEqual([]);
      expect(proof.counts.changedPaths).toBe(0);
      expect(proof.verifierWrites).toEqual({
        legacyMarkdown: 0,
        recordStore: 0,
        externalArtifacts: 0,
        activation: 0,
      });
      expect(proof.counts.legacyMarkdownBefore).toBeGreaterThan(0);
      expect(proof.counts.legacyMarkdownAfter).toBe(proof.counts.legacyMarkdownBefore);
      expect(proof.counts.vaultExternalFilesBefore).toBeGreaterThanOrEqual(3);
      expect(proof.counts.vaultExternalFilesAfter).toBe(proof.counts.vaultExternalFilesBefore);
      expect(proof.operationResult.projects.staged.length).toBeGreaterThan(0);
      expect(proof.operationResult.tasks.staged.length).toBeGreaterThan(0);
      expect(proof.operationResult.events.staged.length).toBeGreaterThan(0);
      expect(staging.records.size).toBeGreaterThan(0);
      expect(proof.operationResult.projects.activation).toBe('not-performed');
      expect(proof.operationResult.tasks.activation).toBe('not-performed');
      expect(proof.operationResult.events.activation).toBe('not-performed');
      expect(proof.operationResult.schema.activation).toBe('not-performed');

      // The filesystem's own account, independent of the reader: nothing changed, nothing
      // was added, nothing was removed — including the non-Markdown artifacts.
      expect(changedBetween(before, after)).toEqual([]);
      expect(after.get('Notes/attachment.bin')?.sha256).toBe(before.get('Notes/attachment.bin')?.sha256);
      expect(after.get('Drawings/knowledge.canvas')?.sha256).toBe(before.get('Drawings/knowledge.canvas')?.sha256);

      // And the verifier is not lying to us: every digest it reported is the digest the
      // filesystem reports for that path.
      for (const entry of proof.after.entries) {
        expect(entry.sha256).toBe(after.get(entry.path)?.sha256);
        expect(entry.size).toBe(after.get(entry.path)?.size);
      }
      expect(proof.after.entries.length).toBe(
        proof.counts.legacyMarkdownAfter + proof.counts.vaultExternalFilesAfter,
      );

      // Staging is not canonical and nothing switched the product's source: the application
      // still reads the legacy vault, and the staged records are nowhere in it.
      const state = await loadVaultState(vault);
      expect(state.state.projects.length).toBeGreaterThan(0);
      expect(state.state.tasks.length).toBeGreaterThan(0);
      expect(state.state.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(state.state)).not.toContain(opaqueRecordId(1));
    } finally {
      await removeDiskFixture(root);
    }
  });

  it('stages the records a vault can convert while the ones it cannot are reported, not guessed', async () => {
    const root = await disposableFixture('vault-malformed');
    try {
      const vault = createDiskVault(root);
      const importPlan = await planLegacyMarkdownImport(
        vault,
        sequentialRecordAllocator(),
        {},
        null,
        { snapshot: EMPTY_LEGACY_SCHEMA_SNAPSHOT, allocator: sequentialSchemaAllocator() },
        { allocator: sequentialArtifactAllocator() },
      );
      const before = await diskDigests(root);
      const staging = new MemoryStagingStore();

      const proof = await runLegacyImportBytePreservationProof(
        vault,
        importPlan,
        {},
        MAX_TEST_FILE_BYTES,
        async () => stageEverything(importPlan, staging),
      );

      // The fixture is a vault with records the reader rejects, so the plan reports them and
      // the run still converts what it can — the two halves the box asks for at once. Every
      // candidate is accounted for as either staged or blocked, so nothing was guessed.
      expect(importPlan.problems.length).toBeGreaterThan(0);
      expect(proof.operationResult.projects.staged.length
        + proof.operationResult.tasks.staged.length
        + proof.operationResult.events.staged.length).toBeGreaterThan(0);
      expect(proof.verdict).toBe('preserved');
      expect(changedBetween(before, await diskDigests(root))).toEqual([]);

      const stagedPaths = new Set(
        [...proof.operationResult.projects.staged, ...proof.operationResult.tasks.staged, ...proof.operationResult.events.staged]
          .map((record) => (record as { sourcePath?: string }).sourcePath),
      );

      const taskCounts = proof.operationResult.tasks.counts;
      expect(taskCounts.created + taskCounts.reusedIdentical + taskCounts.blocked)
        .toBe(taskCounts.taskCandidates);
      const eventCounts = proof.operationResult.events.counts;
      expect(eventCounts.created + eventCounts.reusedIdentical + eventCounts.blocked)
        .toBe(eventCounts.eventCandidates);

      // The fixture's fifteen problems are all warnings: the reader is tolerant, so the records
      // entered state with the fields that were read, and staging then converts the ones whose
      // canonical payload it can build while reporting the rest as blockers. That is the box's
      // two halves in one run — valid records prepared, the ones it cannot prepare named.
      expect(importPlan.problems.every((problem) => problem.severity === 'warning')).toBe(true);
      const blockers = proof.operationResult.tasks.blockers.length + proof.operationResult.events.blockers.length
        + proof.operationResult.projects.blockers.length;
      expect(blockers).toBeGreaterThan(0);
      expect(proof.operationResult.tasks.counts.created + proof.operationResult.events.counts.created
        + proof.operationResult.projects.counts.created).toBeGreaterThan(0);
      for (const blocker of [...proof.operationResult.tasks.blockers, ...proof.operationResult.events.blockers]) {
        expect(typeof (blocker as { reason?: string }).reason).toBe('string');
      }
    } finally {
      await removeDiskFixture(root);
    }
  });

  it('runs the whole staging pass over all four fixture vaults without changing one of their bytes', async () => {
    const fixtures = ['vault-basic', 'vault-legacy', 'vault-duplicates', 'vault-malformed'] as const;
    const report: Record<string, { staged: number; blocked: number; candidates: number; verdict: string }> = {};
    const rejectedRecordPaths: string[] = [];
    const fixturesWithCollisions: string[] = [];

    for (const fixture of fixtures) {
      const root = await disposableFixture(fixture);
      try {
        const vault = createDiskVault(root);
        const importPlan = await planLegacyMarkdownImport(
          vault,
          sequentialRecordAllocator(),
          {},
          null,
          { snapshot: EMPTY_LEGACY_SCHEMA_SNAPSHOT, allocator: sequentialSchemaAllocator() },
          { allocator: sequentialArtifactAllocator() },
        );
        const before = await diskDigests(root);
        const staging = new MemoryStagingStore();

        const proof = await runLegacyImportBytePreservationProof(
          vault,
          importPlan,
          {},
          MAX_TEST_FILE_BYTES,
          async () => stageEverything(importPlan, staging),
        );

        expect(proof.verdict).toBe('preserved');
        expect(changedBetween(before, await diskDigests(root))).toEqual([]);

        // Every candidate the plan found is either staged or blocked by name, in each kind:
        // a fixture with duplicate or malformed records must not quietly drop one.
        const projects = proof.operationResult.projects;
        expect(projects.counts.created + projects.counts.reusedIdentical + projects.counts.blocked)
          .toBe(projects.counts.projectCandidates);
        const tasks = proof.operationResult.tasks;
        expect(tasks.counts.created + tasks.counts.reusedIdentical + tasks.counts.blocked)
          .toBe(tasks.counts.taskCandidates);
        const events = proof.operationResult.events;
        expect(events.counts.created + events.counts.reusedIdentical + events.counts.blocked)
          .toBe(events.counts.eventCandidates);

        // The product still reads the legacy tree afterwards, whatever the plan decided.
        const state = await loadVaultState(vault);
        expect(state.state.projects.length + state.state.tasks.length + state.state.events.length)
          .toBeGreaterThanOrEqual(0);

        // A record the reader refused to take into state is reported by the plan; whether it is
        // *staged* is a separate question the plan answers per record — a duplicate legacy id
        // is deliberately staged as its own candidate with a distinct id, because choosing one
        // silently is the failure mode the duplicate section exists to prevent. So the sweep
        // records what the plan reported and asserts the accounting above, rather than
        // asserting a blanket exclusion that the duplicate policy contradicts.
        for (const problem of importPlan.problems.filter((candidate) => candidate.severity === 'error')) {
          rejectedRecordPaths.push(problem.sourcePath);
        }
        if (importPlan.collisions.length > 0) fixturesWithCollisions.push(fixture);

        report[fixture] = {
          staged: projects.counts.created + tasks.counts.created + events.counts.created,
          blocked: projects.counts.blocked + tasks.counts.blocked + events.counts.blocked,
          candidates: projects.counts.projectCandidates + tasks.counts.taskCandidates + events.counts.eventCandidates,
          verdict: proof.verdict,
        };
      } finally {
        await removeDiskFixture(root);
      }
    }

    // A sweep over four vaults where nothing was ever staged would prove nothing, and one
    // where nothing was ever blocked would mean the fixtures are not testing the hard paths.
    expect(Object.values(report).reduce((total, entry) => total + entry.staged, 0)).toBeGreaterThan(0);
    expect(Object.values(report).reduce((total, entry) => total + entry.blocked, 0)).toBeGreaterThan(0);
    // And the sweep was not a walk over four easy vaults: at least one fixture holds records the
    // reader refused, and at least one holds an identity collision the plan had to report.
    expect(rejectedRecordPaths.length).toBeGreaterThan(0);
    expect(fixturesWithCollisions.length).toBeGreaterThan(0);
  });

  it('refuses to stage into anything that is not the isolated staging authority', async () => {
    const root = await disposableFixture('vault-basic');
    try {
      const vault = createDiskVault(root);
      const importPlan = await planLegacyMarkdownImport(
        vault,
        sequentialRecordAllocator(),
        {},
        null,
        null,
        { allocator: sequentialArtifactAllocator() },
      );
      const before = await diskDigests(root);

      // A store that claims to be the canonical record store is not a staging store, and the
      // materializers say so rather than writing into it.
      const canonicalLooking = {
        ...new MemoryStagingStore(),
        authority: 'canonical-record-store',
      } as unknown as LegacyImportStagingStore;

      await expect(
        materializeLegacyImportProjectStaging(importPlan, canonicalLooking),
      ).rejects.toThrow(/staging-only authority/);
      await expect(
        materializeLegacyImportTaskStaging(importPlan, canonicalLooking, { entries: [] } as unknown as LegacyImportWorkflowStageIdentityMappingManifest),
      ).rejects.toThrow(/staging-only authority/);

      expect(changedBetween(before, await diskDigests(root))).toEqual([]);
    } finally {
      await removeDiskFixture(root);
    }
  });
});
