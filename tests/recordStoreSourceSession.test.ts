/**
 * HARD GATE C items 1–3, at the level they can be proven today: a session whose records come
 * from the Proxima record store while notes keep reading the vault.
 *
 * The claim under test is isolation, and it is the sharpest thing the cutover has to get
 * right: once records come from the store, editing the legacy Markdown those records were
 * imported from must change **nothing** the surfaces read, and it must not reach the store
 * either. The vault is still a real source of something — notes, drawings and attachments —
 * so the test also keeps writing to it and checking that half still works.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { loadRecordStoreState } from '../src/app/recordStoreStateLoad.js';
import { createSourceSession, type SourceCandidate } from '../src/app/sourceSession.js';
import { recordStoreStateSource, vaultStateSource, type StateSourceLoad } from '../src/app/stateSource.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import type { CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { canonicalOrderPosition } from '../src/domain/canonicalOrdering.js';
import type { CanonicalEventRecordV2, CanonicalProjectRecordV2, CanonicalTaskRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { MemoryRecordFiles } from './test-record-store.js';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const TASK_RUNNING = idFromLastByte(10);
const TASK_EXTRA = idFromLastByte(11);
const EVENT = idFromLastByte(20);

function projectRecord(name: string): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name }),
    description: 'From the record store',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

function taskRecord(id: OpaqueRecordId, name: string, order: number): CanonicalTaskRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'task', id, name }),
    projectId: PROJECT,
    executionState: 'running',
    workflowStageId: null,
    executionOrder: canonicalOrderPosition(order),
    workflowOrder: null,
    description: `${name} description`,
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

/** The legacy Markdown this world was imported from — deliberately different names. */
function legacyVault() {
  return createMemoryVault({
    'Proxima/projects/port.md': [
      '---',
      'id: port',
      'name: Legacy project name',
      'status: active',
      'createdAt: 2026-08-01T00:00:00.000Z',
      '---',
      'Legacy body',
      '',
    ].join('\n'),
    'Proxima/tasks/running.md': [
      '---',
      'id: running',
      'name: Legacy task name',
      'project: port',
      'status: running',
      'weight: 1',
      'orderIndex: 1',
      'isCompleted: false',
      'createdAt: 2026-08-01T00:00:00.000Z',
      '---',
      'Legacy body',
      '',
    ].join('\n'),
    'Notes/standup.md': '# Standup\n\nA note that stays a vault file.\n',
  });
}

function schedulerHarness() {
  const timers = new Set<number>();
  let next = 1;
  return {
    scheduler: {
      setInterval: () => {
        const handle = next++;
        timers.add(handle);
        return handle;
      },
      clearInterval: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    timers,
  };
}

/** The session's artifact reader, which every mode must have. */
function vaultReader(session: { reader?(): Parameters<typeof loadVaultState>[0] }): Parameters<typeof loadVaultState>[0] {
  const reader = session.reader?.();
  if (reader === undefined) throw new Error('session has no artifact reader');
  return reader;
}

async function recordStoreWorld(): Promise<{
  files: MemoryRecordFiles;
  candidate: SourceCandidate;
  vault: ReturnType<typeof legacyVault>;
  load: () => Promise<StateSourceLoad>;
}> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  for (const record of [projectRecord('Store project') as CanonicalRecordV2, taskRecord(TASK_RUNNING, 'Store task', 1) as CanonicalRecordV2, eventRecord() as CanonicalRecordV2]) {
    const result = await store.createIfAbsent(record);
    expect(result.ok).toBe(true);
  }
  const vault = legacyVault();
  const source = recordStoreStateSource(store);
  const loaded = await loadRecordStoreState(store);
  return {
    files,
    vault,
    candidate: {
      mode: 'record-store',
      reader: vault,
      source,
      initial: { state: loaded.state, problems: [], revisions: loaded.revisions },
    },
    load: () => source.load(),
  };
}

describe('HARD GATE C record-store source session', () => {
  it('activates a record-store candidate and keeps the vault for artifacts', async () => {
    const world = await recordStoreWorld();
    const harness = schedulerHarness();
    const session = createSourceSession({ initial: world.candidate, scheduler: harness.scheduler, intervalMs: 60_000 });

    expect(session.snapshot()).toMatchObject({ sourceMode: 'record-store', sourceGeneration: 1, transitionState: 'stable' });
    const state = session.projection().state;
    expect(state.projects.map((project) => project.name)).toEqual(['Store project']);
    expect(state.tasks.map((task) => task.name)).toEqual(['Store task']);
    expect(state.events.map((event) => event.name)).toEqual(['Store event']);
    // Records came from the store, and the projection says so.
    expect(state.tasks[0]?.source.idOrigin).toBe('record-store');

    // The vault is still there for the half the record store deliberately does not hold.
    expect(session.reader?.()).toBe(world.vault);
    expect((await vaultReader(session).read('Notes/standup.md')).text).toContain('stays a vault file');
    expect(session.snapshot()).toMatchObject({ sourceMode: 'record-store' });
    session.dispose();
  });

  it('refreshes when the store changes, and reports what changed', async () => {
    const world = await recordStoreWorld();
    const session = createSourceSession({ initial: world.candidate, scheduler: schedulerHarness().scheduler, intervalMs: 60_000 });
    const store = createCanonicalJsonRecordStore(world.files);

    const unchanged = await session.refresh('manual');
    expect(unchanged).toMatchObject({ ok: true, outcome: 'unchanged', changed: false });
    expect(session.snapshot().sourceGeneration).toBe(1);

    const added = await store.createIfAbsent(taskRecord(TASK_EXTRA, 'Second store task', 2));
    expect(added.ok).toBe(true);

    const changed = await session.refresh('manual');
    expect(changed).toMatchObject({ ok: true, outcome: 'changed', changed: true });
    expect(session.snapshot().sourceGeneration).toBe(2);
    expect(session.projection().state.tasks.map((task) => task.name)).toEqual(['Store task', 'Second store task']);
    session.dispose();
  });

  it('is not moved by edits to the legacy vault, and never writes the store from one', async () => {
    const world = await recordStoreWorld();
    const session = createSourceSession({ initial: world.candidate, scheduler: schedulerHarness().scheduler, intervalMs: 60_000 });
    const store = createCanonicalJsonRecordStore(world.files);
    const before = await store.list();
    const beforeRevisions = before.map((observation) => observation.observedRevision);

    // An ordinary external edit to the Markdown these records came from: a rename, then the
    // file disappearing entirely — the two things the cutover's acceptance boxes ask about.
    world.vault.set('Proxima/tasks/running.md', [
      '---',
      'id: running',
      'name: Edited after cutover',
      'project: port',
      'status: running',
      'weight: 1',
      'orderIndex: 1',
      'isCompleted: false',
      'createdAt: 2026-08-01T00:00:00.000Z',
      '---',
      'Edited body',
      '',
    ].join('\n'));
    const afterRename = await session.refresh('manual');
    expect(afterRename).toMatchObject({ ok: true, outcome: 'unchanged', changed: false });
    expect(session.projection().state.tasks.map((task) => task.name)).toEqual(['Store task']);

    world.vault.delete('Proxima/tasks/running.md');
    world.vault.set('Notes/standup.md', '# Standup\n\nEdited, and still a note.\n');
    const afterRemoval = await session.refresh('manual');
    expect(afterRemoval).toMatchObject({ ok: true, outcome: 'unchanged', changed: false });
    expect(session.projection().state.tasks.map((task) => task.name)).toEqual(['Store task']);

    // The store is untouched by both edits: same records, same observed revisions, and the
    // vault's own half still reads what the vault now says.
    const after = await store.list();
    expect(after.map((observation) => observation.id)).toEqual(before.map((observation) => observation.id));
    expect(after.map((observation) => observation.observedRevision)).toEqual(beforeRevisions);
    expect((await vaultReader(session).read('Notes/standup.md')).text).toContain('still a note');
    session.dispose();
  });

  it('switches between a legacy candidate and the record store in both directions', async () => {
    const world = await recordStoreWorld();
    const fixture = createMemoryVault({
      'Proxima/projects/legacy.md': [
        '---',
        'id: legacy',
        'name: Legacy-only project',
        'status: active',
        'createdAt: 2026-08-01T00:00:00.000Z',
        '---',
        'body',
        '',
      ].join('\n'),
    });
    const legacyCandidate: SourceCandidate = {
      mode: 'fixture',
      reader: fixture,
      initial: await loadVaultState(fixture),
    };
    const harness = schedulerHarness();
    const session = createSourceSession({ initial: legacyCandidate, scheduler: harness.scheduler, intervalMs: 60_000 });
    expect(session.projection().state.projects.map((project) => project.name)).toEqual(['Legacy-only project']);

    const switched = await session.switchTo(world.candidate);
    expect(switched).toMatchObject({ ok: true, sourceMode: 'record-store', snapshot: { sourceGeneration: 2, transitionState: 'stable' } });
    expect(session.projection().state.projects.map((project) => project.name)).toEqual(['Store project']);
    // One active policy, whatever the source.
    expect(harness.timers.size).toBe(1);

    const back = await session.switchTo({
      mode: 'fixture',
      reader: fixture,
      initial: await loadVaultState(fixture),
      source: vaultStateSource(fixture),
    });
    expect(back).toMatchObject({ ok: true, sourceMode: 'fixture', snapshot: { sourceGeneration: 3 } });
    expect(session.projection().state.projects.map((project) => project.name)).toEqual(['Legacy-only project']);
    expect(harness.timers.size).toBe(1);
    session.dispose();
  });

  it('refuses a record-store candidate with no record source rather than reading the vault as records', async () => {
    const world = await recordStoreWorld();
    const session = createSourceSession({ initial: world.candidate, scheduler: schedulerHarness().scheduler, intervalMs: 60_000 });

    const refused = await session.switchTo({
      mode: 'record-store',
      reader: world.vault,
      initial: await loadVaultState(world.vault),
    });

    expect(refused).toMatchObject({ ok: false, sourceMode: 'record-store', snapshot: { transitionState: 'failed' } });
    // The previous source is still what the session serves.
    expect(session.projection().state.projects.map((project) => project.name)).toEqual(['Store project']);
    session.dispose();
  });
});
