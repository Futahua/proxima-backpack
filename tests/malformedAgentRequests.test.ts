/**
 * Stage 0's box: malformed agent requests never reach mutation storage.
 *
 * Its note said "partially: malformed input is proven to leave dispatcher state untouched; there is no
 * mutation storage to reach yet". The second half of that is no longer true — there is real mutation
 * storage now (a canonical record store behind a conditional mutation coordinator) — so the claim can be
 * finished rather than left at "partially".
 *
 * The test attacks the one path an agent actually has, `parseAction` and `dispatch`, with everything a
 * confused or hostile caller can send, and asserts the storage claim the hard way: a real store with real
 * records in it, whose file list and per-file revisions are compared before and after the whole battery.
 * "Never reach mutation storage" is then a fact about bytes rather than about intent.
 *
 * It is deliberately not a claim about the semantic operation layer: the dispatcher registers no
 * record-mutation action at all (D55 — the UI reaches record mutations through the operations, not the
 * dispatcher), which is exactly why a record-mutating payload has no path from here, and the operations'
 * own refusals are asserted where those operations live.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createActionDispatcher, parseAction } from '../src/app/actionProtocol.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T09:00:00+07:00';

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(1);
const TASK = idFromLastByte(2);

interface World {
  files: MemoryRecordFiles;
  dispatcher: ReturnType<typeof createActionDispatcher>;
  snapshot: () => Promise<{ files: string[]; revisions: Record<string, string> }>;
}

async function world(): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);

  for (const record of [
    {
      ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Project' }),
      description: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'active',
      archivedAt: null,
      artifactBindings: [],
    },
    {
      ...defineCanonicalRecordHeader({ kind: 'task', id: TASK, name: 'Task' }),
      projectId: PROJECT,
      executionState: 'backlog',
      workflowStageId: null,
      executionOrder: 0,
      workflowOrder: null,
      description: '',
      weight: 1,
      isFixedDuration: false,
      fixedDuration: null,
      maxDuration: null,
      isCompleted: false,
      createdAt: '2026-08-02T00:00:00.000Z',
      startDate: null,
      deadline: null,
      properties: {},
      recurrence: null,
    },
  ] as CanonicalRecordV2[]) {
    expect((await store.createIfAbsent(record)).ok).toBe(true);
  }

  const loaded = await recordStoreStateSource(store).load();
  const dispatcher = createActionDispatcher({
    state: loaded.state,
    problems: loaded.problems,
    revisions: loaded.revisions,
    mode: 'fixture',
    clock: fixedClock(CLOCK_ISO),
  });

  return {
    files,
    dispatcher,
    snapshot: async () => {
      const names = [...(await files.listRecordFiles())].sort();
      const revisions: Record<string, string> = {};
      for (const name of names) revisions[name] = (await files.readRecordFile(name as never))?.revision ?? '';
      return { files: names, revisions };
    },
  };
}

/** Everything a confused or hostile agent can send, including payloads that name real verbs. */
const MALFORMED: readonly unknown[] = [
  null,
  undefined,
  42,
  'surface.select',
  [],
  {},
  { type: 7 },
  { type: 'unknown.action' },
  { type: 'task.update' },
  { type: 'task.delete' },
  { type: 'surface.select' },
  { type: 'surface.select', surface: 'nonsense' },
  { type: 'surface.select', surface: 12 },
  { type: 'calendar.shift-month', delta: 5 },
  { type: 'calendar.shift-month', delta: '1' },
  { type: 'project.select', projectId: 42 },
  JSON.parse('{"__proto__":{"type":"surface.select","surface":"tasks"}}') as unknown,
];

/**
 * Requests that parse because the protocol registers the verb, but which can still not reach record
 * storage: the containment rule is that a registered record-mutation action is answered as unavailable
 * through the dispatcher, because record writes live behind the operation layer (D55).
 */
describe('record-mutation-shaped requests through the protocol', () => {
  it('are answered as unavailable, and write nothing', async () => {
    const app = await world();
    const before = await app.snapshot();

    const parsed = parseAction({ type: 'project.delete', projectId: PROJECT });
    expect(parsed.ok).toBe(true);

    const result = app.dispatcher.dispatch({ type: 'project.delete', projectId: PROJECT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error.code).toBe('string');
    expect(await app.snapshot()).toEqual(before);
  });
});

describe('malformed agent requests', () => {
  it('are refused by the parser with typed, machine-readable errors', () => {
    for (const payload of MALFORMED) {
      const parsed = parseAction(payload);
      expect(parsed.ok, `payload ${JSON.stringify(payload)} must not parse`).toBe(false);
      if (parsed.ok) continue;
      expect(typeof parsed.error.code).toBe('string');
      expect(parsed.error.message.length).toBeGreaterThan(0);
    }
    // The parser is not simply refusing everything: the same shape with a valid surface is accepted,
    // which is what makes the refusals above mean "malformed" rather than "unimplemented".
    expect(parseAction({ type: 'surface.select', surface: 'canvas' }).ok).toBe(true);
  });

  it('never reach mutation storage, and leave the dispatcher exactly where it was', async () => {
    const app = await world();
    const before = await app.snapshot();
    const stateBefore = app.dispatcher.snapshot();

    for (const payload of MALFORMED) {
      const result = app.dispatcher.dispatch(payload);
      expect(result.ok, `payload ${JSON.stringify(payload)} must be refused`).toBe(false);
      if (result.ok) continue;
      expect(typeof result.error.code).toBe('string');
    }

    // The dispatcher's own state is untouched, and — the half the box was missing — so is the store:
    // the same files with the same revisions, byte for byte.
    // The local state the surfaces draw from is where it was. The comparison is over those fields
    // rather than the whole snapshot because a refusal legitimately advances the dispatcher's own
    // sequence counters: recording that an action was refused is the audit working, not state drifting.
    const localState = (snapshot: typeof stateBefore) => ({
      surface: snapshot.surface,
      selection: snapshot.selection,
      tasksMode: snapshot.tasksMode,
      scheduleMode: snapshot.scheduleMode,
    });
    expect(localState(app.dispatcher.snapshot())).toEqual(localState(stateBefore));
    expect(await app.snapshot()).toEqual(before);
  });

  it('reaches no storage even when the request is a well-formed action of a category that writes', async () => {
    const app = await world();
    const before = await app.snapshot();

    // A syntactically perfect local-state action still changes no record: the dispatcher's actions are
    // presentation and local state, and every record mutation lives behind the operation layer (D55),
    // so there is no payload shape that turns this entry point into a record write.
    expect(app.dispatcher.dispatch({ type: 'surface.select', surface: 'projects' }).ok).toBe(true);
    expect(app.dispatcher.dispatch({ type: 'calendar.shift-month', delta: 1 }).ok).toBe(true);

    expect(await app.snapshot()).toEqual(before);
  });
});
