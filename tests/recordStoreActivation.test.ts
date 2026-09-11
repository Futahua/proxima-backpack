// @vitest-environment happy-dom
//
// HARD GATE C item 1, in two halves: what makes a store canonical (an activation marker that
// can be refused), and which source startup then chooses. The second half is the one that has
// to stay boring — a store with no marker, a marker this build cannot read, or a store that
// no longer holds what was activated all mean the same thing for the product: read the legacy
// vault and say why.
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import {
  activateRecordStore,
  RECORD_STORE_ACTIVATION_SCHEMA_VERSION,
  readRecordStoreActivation,
  type RecordStoreActivationStorage,
} from '../src/app/recordStoreActivation.js';
import { createSourceSession, type SourceCandidate } from '../src/app/sourceSession.js';
import { chooseStartupSource } from '../src/app/startupSourceChoice.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { canonicalOrderPosition } from '../src/domain/canonicalOrdering.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalEventRecordV2, CanonicalProjectRecordV2, CanonicalRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { MemoryRecordFiles } from './test-record-store.js';

const ACTIVATED_AT = '2026-09-12T03:00:00+07:00';
const IMPORT_ID = 'import:legacy-markdown:v1';

class MemoryActivationStorage implements RecordStoreActivationStorage {
  text: string | undefined;

  reads = 0;

  writes = 0;

  failRead = false;

  async read(): Promise<string | undefined> {
    this.reads += 1;
    if (this.failRead) throw new Error('activation storage unavailable');
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.writes += 1;
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const TASK = idFromLastByte(10);
const EVENT = idFromLastByte(20);

function projectRecord(): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Store project' }),
    description: 'From the record store',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function taskRecord(): CanonicalTaskRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'task', id: TASK, name: 'Store task' }),
    projectId: PROJECT,
    executionState: 'running',
    workflowStageId: null,
    executionOrder: canonicalOrderPosition(1),
    workflowOrder: null,
    description: 'From the record store',
    weight: 1,
    isFixedDuration: false,
    fixedDuration: null,
    maxDuration: null,
    isCompleted: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    startDate: null,
    deadline: '2026-09-09T09:00:00.000Z',
    properties: {},
    recurrence: null,
  };
}

function eventRecord(): CanonicalEventRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'event', id: EVENT, name: 'Store event' }),
    startDate: '2026-09-08T10:00:00.000Z',
    deadline: '2026-09-08T11:00:00.000Z',
    description: 'From the record store',
    projectId: PROJECT,
    createdAt: '2026-08-01T00:00:00.000Z',
    isCompleted: false,
    properties: {},
    recurrence: null,
  };
}

async function filledStore(): Promise<{ files: MemoryRecordFiles; store: ReturnType<typeof createCanonicalJsonRecordStore> }> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  for (const record of [projectRecord() as CanonicalRecordV2, taskRecord() as CanonicalRecordV2, eventRecord() as CanonicalRecordV2]) {
    const result = await store.createIfAbsent(record);
    expect(result.ok).toBe(true);
  }
  return { files, store };
}

function legacyVault() {
  return createMemoryVault({
    'Proxima/projects/port.md': [
      '---',
      'id: port',
      'name: Legacy project',
      'status: active',
      'createdAt: 2026-08-01T00:00:00.000Z',
      '---',
      'body',
      '',
    ].join('\n'),
    'Notes/standup.md': '# Standup\n',
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('HARD GATE C activation and the startup choice', () => {
  it('refuses to activate a store that holds nothing, and writes no marker', async () => {
    const files = new MemoryRecordFiles();
    const store = createCanonicalJsonRecordStore(files);
    const storage = new MemoryActivationStorage();

    const refused = await activateRecordStore({ store, storage, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID });

    expect(refused).toEqual({ ok: false, reason: 'store-empty', detail: 'no records to activate' });
    expect(storage.text).toBeUndefined();
    expect(storage.writes).toBe(0);
    expect((await readRecordStoreActivation(storage)).status).toBe('absent');
  });

  it('marks a store that holds records, counts what it activated, and cannot be stolen or overwritten', async () => {
    const { store } = await filledStore();
    const storage = new MemoryActivationStorage();

    const activated = await activateRecordStore({ store, storage, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.outcome).toBe('activated');
    expect(activated.marker).toEqual({
      schemaVersion: RECORD_STORE_ACTIVATION_SCHEMA_VERSION,
      activatedAt: ACTIVATED_AT,
      sourceImport: IMPORT_ID,
      counts: { task: 1, project: 1, event: 1, schema: 0, 'workflow-stage': 0 },
    });

    // Reading it back is validation, not trust: the stored text round-trips into a marker.
    const read = await readRecordStoreActivation(storage);
    expect(read.status).toBe('present');
    expect(read.marker).toEqual(activated.marker);

    // Activating again with the same import is idempotent, and writes nothing new.
    const again = await activateRecordStore({ store, storage, activatedAt: '2026-09-13T00:00:00+07:00', sourceImport: IMPORT_ID });
    expect(again).toMatchObject({ ok: true, outcome: 'already-activated' });
    expect(storage.writes).toBe(1);

    // A different import may not adopt the store, and a marker this build cannot read is not
    // overwritten — both are refusals rather than silent repairs.
    const other = await activateRecordStore({ store, storage, activatedAt: ACTIVATED_AT, sourceImport: 'import:something-else' });
    expect(other).toMatchObject({ ok: false, reason: 'different-import' });
    const corrupt = new MemoryActivationStorage();
    corrupt.text = '{"schemaVersion":99}';
    expect(await activateRecordStore({ store, storage: corrupt, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID }))
      .toMatchObject({ ok: false, reason: 'unreadable-marker' });
    expect(corrupt.text).toBe('{"schemaVersion":99}');
  });

  it('chooses the legacy reader for every answer except an intact activated store', async () => {
    const { store } = await filledStore();
    const storage = new MemoryActivationStorage();

    // Never activated: the product keeps reading Markdown and says so.
    const absent = await chooseStartupSource({ store, activation: storage });
    expect(absent).toMatchObject({ kind: 'legacy', reason: 'no-activation-marker', marker: null, detail: 'the record store has never been activated' });

    // A marker this build cannot read is not a licence to guess.
    storage.text = '{"schemaVersion":99,"activatedAt":"x","sourceImport":"y"}';
    expect(await chooseStartupSource({ store, activation: storage }))
      .toMatchObject({ kind: 'legacy', reason: 'invalid-activation-marker' });

    // An unreadable storage is its own answer, not "never activated".
    storage.failRead = true;
    expect(await chooseStartupSource({ store, activation: storage }))
      .toMatchObject({ kind: 'legacy', reason: 'invalid-activation-marker' });
    storage.failRead = false;

    // Activated, then emptied: choosing it would render an empty application, which is worse
    // than reading Markdown, so the fallback wins and the reason is recorded.
    storage.text = undefined;
    await activateRecordStore({ store, storage, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID });
    const emptiedFiles = new MemoryRecordFiles();
    const emptiedStore = createCanonicalJsonRecordStore(emptiedFiles);
    const emptied = await chooseStartupSource({ store: emptiedStore, activation: storage });
    expect(emptied).toMatchObject({ kind: 'legacy', reason: 'empty-store-after-activation' });
    expect(emptied.detail).toContain('now holds none');

    // Activated, then short of what it activated.
    const partial = createCanonicalJsonRecordStore(new MemoryRecordFiles());
    await partial.createIfAbsent(taskRecord());
    const short = await chooseStartupSource({ store: partial, activation: storage });
    expect(short).toMatchObject({ kind: 'legacy', reason: 'store-short-of-activation' });
    expect(short.detail).toContain('now holds 1');

    // An intact activated store is the only answer that chooses it.
    const chosen = await chooseStartupSource({ store, activation: storage });
    expect(chosen).toMatchObject({ kind: 'record-store', reason: 'activated', detail: '' });
    expect(chosen.marker).toMatchObject({ sourceImport: IMPORT_ID });
    expect(chosen.counts).toEqual({ task: 1, project: 1, event: 1, schema: 0, 'workflow-stage': 0 });
  });

  it('is a cutover: an activated store becomes what the surfaces read, with the vault still present', async () => {
    const { store } = await filledStore();
    const storage = new MemoryActivationStorage();
    await activateRecordStore({ store, storage, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID });
    const decision = await chooseStartupSource({ store, activation: storage });
    expect(decision.kind).toBe('record-store');

    const vault = legacyVault();
    const candidate: SourceCandidate = {
      mode: 'record-store',
      reader: vault,
      source: recordStoreStateSource(store),
      initial: await recordStoreStateSource(store).load(),
    };
    const session = createSourceSession({ initial: candidate, intervalMs: 60_000 });

    // The legacy vault is still there — it holds a project named "Legacy project" — and none
    // of it reaches the surfaces, because the source is the store.
    const legacyState = await loadVaultState(vault);
    expect(legacyState.state.projects.map((project) => project.name)).toEqual(['Legacy project']);

    const state = session.projection().state;
    expect(state.projects.map((project) => project.name)).toEqual(['Store project']);
    expect(state.tasks.map((task) => task.name)).toEqual(['Store task']);
    expect(state.tasks[0]?.source.idOrigin).toBe('record-store');

    // And the surfaces render it: the board groups by the canonical execution states.
    document.body.innerHTML = renderProjectTaskBoard(state, state.projects[0]!);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-board-status-column]'))
      .map((column) => column.dataset.projectBoardStatusColumn)).toEqual(['backlog', 'running', 'finished']);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-project-board-status-column="running"] [data-project-board-task-id]'))
      .map((card) => card.dataset.projectBoardTaskId)).toEqual([TASK]);
    // Notes stay a vault file in this mode.
    expect((await session.reader!().read('Notes/standup.md')).text).toContain('Standup');
    session.dispose();
  });

  it('comes back in the same mode after a restart, from the same storages alone', async () => {
    const files = new MemoryRecordFiles();
    const storage = new MemoryActivationStorage();
    const before = createCanonicalJsonRecordStore(files);
    for (const record of [projectRecord() as CanonicalRecordV2, taskRecord() as CanonicalRecordV2, eventRecord() as CanonicalRecordV2]) {
      await before.createIfAbsent(record);
    }
    await activateRecordStore({ store: before, storage, activatedAt: ACTIVATED_AT, sourceImport: IMPORT_ID });

    const firstDecision = await chooseStartupSource({ store: before, activation: storage });
    const firstSession = createSourceSession({
      initial: {
        mode: 'record-store',
        reader: legacyVault(),
        source: recordStoreStateSource(before),
        initial: await recordStoreStateSource(before).load(),
      },
      intervalMs: 60_000,
    });
    const firstState = firstSession.projection().state;
    firstSession.dispose();

    // A restart is: the same durable pieces, brand-new objects. Nothing is carried in memory.
    const reopenedFiles = new MemoryRecordFiles();
    for (const name of await files.listRecordFiles()) {
      const file = await files.readRecordFile(name as never);
      if (file !== undefined) await reopenedFiles.createRecordFile(name as never, file.text);
    }
    const reopenedStorage = new MemoryActivationStorage();
    reopenedStorage.text = storage.text;
    const reopened = createCanonicalJsonRecordStore(reopenedFiles);

    const secondDecision = await chooseStartupSource({ store: reopened, activation: reopenedStorage });
    expect(secondDecision).toEqual(firstDecision);
    const secondSession = createSourceSession({
      initial: {
        mode: 'record-store',
        reader: legacyVault(),
        source: recordStoreStateSource(reopened),
        initial: await recordStoreStateSource(reopened).load(),
      },
      intervalMs: 60_000,
    });
    expect(secondSession.projection().state).toEqual(firstState);
    expect(secondSession.snapshot().sourceMode).toBe('record-store');
    secondSession.dispose();
  });
});
