/**
 * Stage 17's agent write path: the first record verb an agent can submit.
 *
 * Every open box this file serves names the same missing thing - an agent-facing submission path over the
 * action protocol. The loopback bridge is a read-only vault reader (list/read/walk, writes refused) and the
 * dispatcher refuses every record verb with `action-not-available` before the record layer, so until this
 * wire existed no agent could write a record at all.
 *
 * What is asserted here, and why each form is the honest one:
 *
 * - **The dependency set has no cockpit in it.** The agent deps are the write, the refresh, the id source
 *   and the event sink. The module cannot read a projection because its dependency type has no place to
 *   put one, which is checked as text as well as by the compiler.
 * - **The UI entry and the agent entry return the same object.** Both run `moveTaskByGesture`, and the drop
 *   wrapper no longer reshapes its result, so the comparison is whole objects apart from the run's own id
 *   rather than a chosen subset.
 * - **The dispatcher's containment rule is untouched.** The same verb is still refused as
 *   `action-not-available` through `dispatch`, in the same test, with the store byte-identical: the wire is
 *   additive, not a loosening.
 * - **Convergence is the write's own doing.** The cockpit's refresh is the real refresh controller over the
 *   real record-store source and the render count is asserted, so a surface that moved only because the
 *   test re-read the store would fail.
 * - **A race has a refused loser in both directions**, with the revision that beat it named.
 *
 * One difference is asserted rather than smoothed over: a card the board cannot show is refused
 * `unknown-task` *before* the store, because the board has no revision to write against, while an agent
 * naming a record that does not exist reaches the record layer and gets its `not-found`. The two entries
 * answer the same question in different words for a real reason - one of them has a board to consult.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionDispatcher } from '../src/app/actionProtocol.js';
import { categoryOf, registeredActionTypes } from '../src/app/actionTaxonomy.js';
import {
  AGENT_WRITE_VERBS,
  parseAgentWriteSubmission,
  submitAgentWrite,
  type AgentWriteDependencies,
} from '../src/app/agentWritePath.js';
import { projectBacklog } from '../src/app/backlogView.js';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { performElasticDrop } from '../src/app/elasticDropAction.js';
import { createInspectionProjection, type InspectionProjection } from '../src/app/inspection.js';
import { startRecordMutationAuthority } from '../src/app/recordRecoveryStartup.js';
import { createRefreshController, type RefreshReason, type RefreshResult } from '../src/app/refreshController.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createTask, updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { renderProjectTaskBoard } from '../src/browser/projectTaskBoard.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalProjectRecordV2, CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import type { ProximaState, Task } from '../src/domain/types.js';
import type { RecordStoreFileName } from '../src/ports/recordStore.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds, type RecordingAudit } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T06:00:00+07:00';
const BUILD = {
  proximaVersion: '0.1.0',
  gitSha: 'agent-write',
  buildMode: 'fixture',
  domainSchemaVersion: '2',
  controlSchemaVersion: '1',
  fixtureSchemaVersion: '1',
  fixtureHash: 'agent-write',
  lockfileHash: 'agent-write',
  fixedClock: CLOCK_ISO,
};

const AGENT_WRITE_SOURCE = readFileSync(resolve(process.cwd(), 'src/app/agentWritePath.ts'), 'utf8');

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFromLastByte(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

const PROJECT = idFromLastByte(41);

function oid(value: string): OpaqueRecordId {
  return value as OpaqueRecordId;
}

function projectRecord(id: OpaqueRecordId): CanonicalProjectRecordV2 {
  return {
    ...defineCanonicalRecordHeader({ kind: 'project', id, name: 'Agent project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
}

/** The cockpit as the shell composes it: a projection the surfaces draw from, and a refresh that follows it. */
interface Cockpit {
  state: ProximaState;
  /** How many times the surfaces were redrawn. A test that re-read the store itself would not move this. */
  renders: number;
}

interface World {
  readonly files: MemoryRecordFiles;
  readonly cockpit: Cockpit;
  readonly audit: RecordingAudit;
  /** The cockpit-free dependency set an agent gets: no projection, no refusal sink, no render. */
  readonly agent: AgentWriteDependencies;
  state(): Promise<ProximaState>;
  taskNamed(name: string): Promise<Task>;
  revisionOf(taskId: string): Promise<string | undefined>;
  fileNames(): Promise<readonly string[]>;
  revisionMap(): Promise<Record<string, string>>;
  seed(name: string, order: number): Promise<Task>;
  /** The UI's own gesture entry, over the cockpit's projection - what a drop by hand runs. */
  drop(input: { taskId: string; to: 'backlog' | 'running' | 'finished'; index: number; rendered?: ProximaState }): Promise<Record<string, unknown>>;
  inspection(): Promise<InspectionProjection>;
  board(state?: ProximaState): Promise<string>;
  backlogRows(state?: ProximaState): Promise<readonly string[]>;
  /** The Backlog as the surface draws it, for the row markup assertions. */
  backlogHtml(state?: ProximaState): Promise<string>;
  refreshCount(): number;
}

async function world(seedOffset: number): Promise<World> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const authority = await startRecordMutationAuthority({ backend: files, recovery, clock: fixedClock(CLOCK_ISO) });
  if (authority.mutationAuthority !== 'available') throw new Error(`recovery gate blocked the world: ${authority.reason}`);

  let nextId = seedOffset;
  const deps: TaskMutationDependencies = {
    store,
    coordinator: authority.coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFromLastByte(nextId++),
  };
  await store.createIfAbsent(projectRecord(PROJECT) as CanonicalRecordV2);

  const source = recordStoreStateSource(store);
  const controller = createRefreshController({ initial: await source.load(), source });
  const cockpit: Cockpit = { state: (await source.load()).state, renders: 0 };

  // The shell's sequence, made explicit: the source is re-read, the reloaded projection is adopted, and
  // the surfaces are redrawn because the projection changed. Nothing here is the test's own convenience -
  // `convergeAfterWrite` is what calls this, and the render count is what proves that it did.
  const refresh = async (reason: RefreshReason): Promise<RefreshResult> => {
    const result = await controller.refreshSource(reason);
    cockpit.state = result.snapshot.load.state;
    cockpit.renders += 1;
    return result;
  };

  const audit = recordingAudit();
  // One id source per world, shared by both entries, exactly as the shell has one: a fresh generator per
  // call would make every run's id `0001` and hide a wire that reused an id it had already issued.
  const ids = semanticIds();
  const operations = { updateTask: (input: Parameters<typeof updateTask>[1]) => updateTask(deps, input) };

  const agent: AgentWriteDependencies = {
    writes: async () => operations,
    unavailableReason: () => null,
    refresh,
    ids,
    audit,
  };

  const read = async (): Promise<ProximaState> => (await source.load()).state;
  const project = async () => (await read()).projects[0]!;

  return {
    files,
    cockpit,
    audit,
    agent,
    state: read,
    taskNamed: async (name) => {
      const found = (await read()).tasks.find((task) => task.name === name);
      if (found === undefined) throw new Error(`task ${name} is not in the projection`);
      return found;
    },
    revisionOf: async (taskId) => (await store.read(oid(taskId)))?.observedRevision,
    fileNames: async () => await files.listRecordFiles(),
    revisionMap: async () => {
      const map: Record<string, string> = {};
      for (const fileName of await files.listRecordFiles()) {
        map[fileName] = (await files.readRecordFile(fileName as RecordStoreFileName))!.revision;
      }
      return map;
    },
    seed: async (name, order) => {
      const created = await createTask(deps, { name, projectId: PROJECT, executionState: 'backlog', executionOrder: order });
      if (!created.ok) throw new Error(`seeding failed: ${created.reason}`);
      cockpit.state = await read();
      const found = cockpit.state.tasks.find((task) => task.id === created.recordId);
      if (found === undefined) throw new Error('the seeded task is not in the projection');
      return found;
    },
    drop: async (input) => await performElasticDrop(
      {
        state: input.rendered ?? cockpit.state,
        writes: async () => operations,
        unavailableReason: () => null,
        refresh,
        setRefusal: () => undefined,
        render: () => { cockpit.renders += 1; },
        ids,
        audit,
      },
      { taskId: input.taskId, targetColumn: input.to, targetIndex: input.index },
    ) as unknown as Record<string, unknown>,
    inspection: async () => {
      const loaded = await source.load();
      const dispatcher = createActionDispatcher({
        state: loaded.state,
        problems: [],
        revisions: loaded.revisions,
        mode: 'fixture',
        clock: fixedClock(CLOCK_ISO),
        idGenerator: sequentialIdGenerator(),
      });
      return createInspectionProjection(dispatcher.snapshot(), BUILD);
    },
    board: async (state) => {
      const current = state ?? cockpit.state;
      return renderProjectTaskBoard(current, current.projects[0]!);
    },
    backlogRows: async (state) => {
      const current = state ?? cockpit.state;
      return projectBacklog(current, current.projects[0]!, {
        ...EMPTY_PROJECT_BACKLOG_VIEW,
        projectId: current.projects[0]!.id,
      }).rows.map((row) => row.taskId);
    },
    backlogHtml: async (state) => {
      const current = state ?? cockpit.state;
      return renderProjectBacklog(current, current.projects[0]!, {
        ...EMPTY_PROJECT_BACKLOG_VIEW,
        projectId: current.projects[0]!.id,
      });
    },
    refreshCount: () => cockpit.renders,
  };
}

/** Which column the board drew a card in, read out of the rendered markup rather than from the state. */
function boardColumnOf(html: string, taskId: string): string | null {
  const at = html.indexOf(`data-project-board-task-id="${taskId}"`);
  if (at < 0) return null;
  const columnAt = html.slice(0, at).lastIndexOf('data-project-board-status-column="');
  if (columnAt < 0) return null;
  const rest = html.slice(columnAt + 'data-project-board-status-column="'.length);
  return rest.slice(0, rest.indexOf('"'));
}

/** The card ids a column drew, in the order it drew them. */
function boardColumnCards(html: string, status: string): string[] {
  const start = html.indexOf(`data-project-board-status-column="${status}"`);
  if (start < 0) return [];
  const next = html.indexOf('data-project-board-status-column="', start + 1);
  const section = html.slice(start, next < 0 ? html.length : next);
  return [...section.matchAll(/data-project-board-task-id="([^"]+)"/g)].map((match) => match[1]!);
}

/** Record ids out of a value, so two worlds can be compared without comparing their allocators. */
function normalised(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/pxr_[0-9a-f]{32}/g, '<id>'));
}

/** Two results compared as whole objects, with the run's own id and the two worlds' record ids set aside. */
function comparable(value: Record<string, unknown>): unknown {
  const { requestId, ...rest } = value;
  expect(typeof requestId).toBe('string');
  expect(requestId).not.toBe('');
  // Identity is the one thing the two callers should differ in: each world allocates its own record ids,
  // and a comparison that carried them would be testing the allocator. Same rule as Stage 9's parity file.
  return normalised(rest);
}

describe('agent write path', () => {
  it('lets an agent write a record with no cockpit in the dependency set', async () => {
    const w = await world(500);
    const task = await w.seed('Agent moved', 0);

    const result = await submitAgentWrite(w.agent, {
      type: 'task.execution.move',
      taskId: task.id,
      from: 'backlog',
      to: 'running',
      targetIndex: 2,
      expectedRevision: task.source.revision,
    });

    expect(result).toMatchObject({ ok: true, actionType: 'task.execution.move', outcome: 'moved' });
    if (!result.ok) throw new Error('the agent write was refused');
    expect(result.requestId).toMatch(/^semantic-request/);
    // The per-record half of the result contract: the record's own revision, not just the cockpit's.
    expect(result.revision).toBe(await w.revisionOf(task.id));
    expect(result.revision).not.toBe(task.source.revision);

    const after = await w.taskNamed('Agent moved');
    expect(after.status).toBe('running');
    expect(after.orderIndex).toBe(2);

    // One terminal event, naming the verb, the record and the id the result carried.
    expect(w.audit.events).toEqual([{
      requestId: result.requestId,
      actionType: 'task.execution.move',
      outcome: 'accepted',
      entityIds: [task.id],
    }]);

    // The wire cannot reach a cockpit: its dependency type has no projection to read, and neither does the
    // module - a source read is the check that survives a well-meaning later edit.
    expect(AGENT_WRITE_SOURCE).not.toContain('ProximaState');
    expect(Object.keys(w.agent).sort()).toEqual(['audit', 'ids', 'refresh', 'unavailableReason', 'writes']);
  });

  it('returns the same result object as the UI gesture, for an accepted run and for a lost race', async () => {
    const ui = await world(600);
    const agent = await world(700);
    const uiTask = await ui.seed('Parity', 1);
    const agentTask = await agent.seed('Parity', 1);

    const moved = await ui.drop({ taskId: uiTask.id, to: 'running', index: 2 });
    const submitted = await submitAgentWrite(agent.agent, {
      type: 'task.execution.move',
      taskId: agentTask.id,
      from: 'backlog',
      to: 'running',
      targetIndex: 2,
      expectedRevision: agentTask.source.revision,
    });
    if (!submitted.ok) throw new Error('the agent write was refused');

    expect(ui.cockpit.state.tasks.find((task) => task.id === uiTask.id)?.status).toBe('running');
    expect(agent.cockpit.state.tasks.find((task) => task.id === agentTask.id)?.status).toBe('running');

    // Whole objects, field for field, with only the run's own request id set aside. The drop wrapper no
    // longer narrows the gesture's result, which is what makes this comparison possible at all.
    expect(comparable(submitted as unknown as Record<string, unknown>)).toEqual(comparable(moved));

    // Each run mints its own id, and each event carries the id of its own result. The inequality is
    // asserted *within* a world - two runs of one id source - because two worlds seeded apart mint the same
    // sequence, which is exactly why identity is normalised in the comparison above.
    const uiEvent = ui.audit.events.at(-1)!;
    const agentEvent = agent.audit.events.at(-1)!;
    expect(uiEvent.requestId).toBe(moved.requestId);
    expect(agentEvent.requestId).toBe(submitted.requestId);
    expect(normalised({ ...uiEvent, requestId: '<id>' })).toEqual(normalised({ ...agentEvent, requestId: '<id>' }));

    // A reorder is the other verb, named by the same rule in both entries. Each side's projection is kept
    // first, because the refusal pair below needs a revision that has already moved.
    const uiBeforeReorder = ui.cockpit.state;
    const agentBeforeReorder = agent.cockpit.state;
    const uiReorder = await ui.drop({ taskId: uiTask.id, to: 'running', index: 0 });
    const agentReorder = await submitAgentWrite(agent.agent, {
      type: 'task.execution.reorder',
      taskId: agentTask.id,
      from: 'running',
      to: 'running',
      targetIndex: 0,
      expectedRevision: (await agent.taskNamed('Parity')).source.revision,
    });
    if (!agentReorder.ok) throw new Error('the agent reorder was refused');
    expect(uiReorder).toMatchObject({ ok: true, actionType: 'task.execution.reorder' });
    expect(comparable(agentReorder as unknown as Record<string, unknown>)).toEqual(comparable(uiReorder));
    // Two runs of one world's id source mint two ids: a wire never reuses a run's correlation.
    expect(agentReorder.requestId).not.toBe(submitted.requestId);
    expect(uiReorder.requestId).not.toBe(moved.requestId);

    // A refusal pair: both entries submit against the revision they read before the reorder, and both name
    // the revision that beat them. This is the "same refusal, same words" half of the parity claim.
    const staleUi = await ui.drop({ taskId: uiTask.id, to: 'finished', index: 0, rendered: uiBeforeReorder });
    const staleAgent = await submitAgentWrite(agent.agent, {
      type: 'task.execution.move',
      taskId: agentTask.id,
      from: 'backlog',
      to: 'finished',
      targetIndex: 0,
      expectedRevision: agentBeforeReorder.tasks.find((task) => task.id === agentTask.id)!.source.revision,
    });
    expect(staleUi).toMatchObject({
      ok: false,
      reason: 'stale-revision',
      detail: 'another writer changed this task first',
      refreshed: true,
      actualRevision: uiReorder.revision,
    });
    expect(comparable(staleAgent as unknown as Record<string, unknown>)).toEqual(comparable(staleUi));

    // A card the board cannot show is refused before the store, while an agent naming a record that does
    // not exist reaches the record layer: the two entries answer the same question in different words
    // because only one of them has a board to consult.
    const noCard = await ui.drop({ taskId: 'pxr_missing', to: 'running', index: 0 });
    expect(noCard).toMatchObject({ ok: false, reason: 'unknown-task', refreshed: false });
    const noRecord = await submitAgentWrite(agent.agent, {
      type: 'task.execution.move',
      taskId: 'pxr_000000000000000000000000000000aa',
      from: 'backlog',
      to: 'running',
      targetIndex: 0,
      expectedRevision: 'pxr_000000000000000000000000000000aa.json@1',
    });
    expect(noRecord).toMatchObject({ ok: false, reason: 'not-found', outcome: 'refused', refreshed: false });

    // The wire reports the record layer's answer without rewriting it, including the one this test would
    // not have guessed: an id that is not a canonical record id at all is a *storage* failure, because the
    // store refuses to read it and the layer maps a refused read to that reason. The wire passes both
    // through unchanged, which is the rule - it owns the outer shape, not the vocabulary underneath it.
    const malformedId = await submitAgentWrite(agent.agent, {
      type: 'task.execution.move',
      taskId: 'pxr_missing',
      from: 'backlog',
      to: 'running',
      targetIndex: 0,
      expectedRevision: 'pxr_missing.json@1',
    });
    expect(malformedId).toMatchObject({ ok: false, reason: 'storage-failure', refreshed: false });
  });

  it('refuses a malformed or unsupported submission with the id it minted, and writes nothing', async () => {
    const w = await world(800);
    const task = await w.seed('Untouched', 0);
    const beforeFiles = await w.fileNames();
    const beforeRevisions = await w.revisionMap();

    const wellFormed = {
      type: 'task.execution.move',
      taskId: task.id,
      from: 'backlog',
      to: 'running',
      targetIndex: 1,
      expectedRevision: task.source.revision,
    };

    const battery: readonly { readonly input: unknown; readonly reason: string; readonly actionType: string }[] = [
      // The declared verb is what a refusal names, even when the record facts imply the other one: the
      // refusal's job is to tell the caller that the two disagree, not to answer for the verb it inferred.
      { input: null, reason: 'malformed-submission', actionType: 'unknown' },
      { input: 42, reason: 'malformed-submission', actionType: 'unknown' },
      { input: 'task.execution.move', reason: 'malformed-submission', actionType: 'unknown' },
      { input: [], reason: 'malformed-submission', actionType: 'unknown' },
      { input: {}, reason: 'malformed-submission', actionType: 'unknown' },
      { input: { ...wellFormed, type: 42 }, reason: 'malformed-submission', actionType: 'unknown' },
      { input: { ...wellFormed, taskId: undefined }, reason: 'malformed-submission', actionType: 'task.execution.move' },
      { input: { ...wellFormed, expectedRevision: '' }, reason: 'malformed-submission', actionType: 'task.execution.move' },
      { input: { ...wellFormed, to: 'parked' }, reason: 'malformed-submission', actionType: 'task.execution.move' },
      { input: { ...wellFormed, targetIndex: '1' }, reason: 'malformed-submission', actionType: 'task.execution.move' },
      { input: { ...wellFormed, type: 'task.execution.reorder' }, reason: 'malformed-submission', actionType: 'task.execution.reorder' },
      { input: { ...wellFormed, type: 'app.explode' }, reason: 'malformed-submission', actionType: 'app.explode' },
      // `task.create` is not in the protocol's registry at all: the create path is an operation with a
      // draft, never a dispatcher verb, so the wire can only answer that no type by that name is registered.
      { input: { ...wellFormed, type: 'task.create' }, reason: 'malformed-submission', actionType: 'task.create' },
      { input: { ...wellFormed, type: 'task.timeline.change' }, reason: 'unsupported-verb', actionType: 'task.timeline.change' },
      { input: { ...wellFormed, type: 'project.create' }, reason: 'unsupported-verb', actionType: 'project.create' },
      { input: { ...wellFormed, type: 'project.delete' }, reason: 'unsupported-verb', actionType: 'project.delete' },
      { input: { ...wellFormed, type: 'event.schedule.create' }, reason: 'unsupported-verb', actionType: 'event.schedule.create' },
      { input: { ...wellFormed, type: 'canvas.node.remove' }, reason: 'unsupported-verb', actionType: 'canvas.node.remove' },
      { input: { ...wellFormed, type: 'surface.select' }, reason: 'unsupported-verb', actionType: 'surface.select' },
    ];

    const results = [];
    for (const entry of battery) {
      const result = await submitAgentWrite(w.agent, entry.input);
      expect(result.ok, `${JSON.stringify(entry.input)} must be refused`).toBe(false);
      expect(result).toMatchObject({ reason: entry.reason, actionType: entry.actionType, refreshed: false });
      expect(result.requestId).toMatch(/^semantic-request/);
      results.push(result);
    }

    // One event per refusal, each carrying the id its own result named, and the two codes this wire uses:
    // `action-not-available` for a verb the product registers and this wire does not run, and the
    // taxonomy's validation code for a submission whose shape is not one.
    expect(w.audit.events).toHaveLength(battery.length);
    expect(w.audit.events.map((event) => event.requestId)).toEqual(results.map((result) => result.requestId));
    expect(w.audit.events.every((event) => event.outcome === 'rejected')).toBe(true);
    expect(w.audit.events.filter((event) => event.errorCode === 'action-not-available').map((event) => event.actionType))
      .toEqual(['task.timeline.change', 'project.create', 'project.delete', 'event.schedule.create', 'canvas.node.remove', 'surface.select']);
    // A refusal names the ids the submission named, and the entries whose shape is not one name none.
    expect(w.audit.events[5]!.entityIds).toEqual([]);
    expect(w.audit.events[13]!.entityIds).toEqual([task.id]);

    // Nothing was written: the same files, at the same revisions.
    expect(await w.fileNames()).toEqual(beforeFiles);
    expect(await w.revisionMap()).toEqual(beforeRevisions);
    expect((await w.taskNamed('Untouched')).status).toBe('backlog');

    // A negative index is well-typed, so it is the gesture's own refusal rather than a second rule here.
    const negative = await submitAgentWrite(w.agent, { ...wellFormed, targetIndex: -1 });
    expect(negative).toMatchObject({ ok: false, reason: 'validation-refused', actionType: 'task.execution.move' });

    // A caller cannot name the id of its own run, and cannot smuggle one in.
    const smuggled = await submitAgentWrite(w.agent, { ...wellFormed, requestId: 'caller-supplied' });
    expect(smuggled.requestId).not.toBe('caller-supplied');
    expect(w.audit.events.at(-1)!.requestId).toBe(smuggled.requestId);
  });

  it('answers every registered record verb, so no agent verb is silently unknown', async () => {
    const recordVerbs = registeredActionTypes().filter((type) => {
      const category = categoryOf(type);
      return category === 'record-mutation' || category === 'artifact-mutation';
    });
    expect(recordVerbs.length).toBeGreaterThan(0);

    const runs: readonly string[] = AGENT_WRITE_VERBS;
    let answered = 0;
    for (const verb of recordVerbs) {
      if (runs.includes(verb)) continue;
      const parsed = parseAgentWriteSubmission({ type: verb, taskId: 'any-task', expectedRevision: 'r1' });
      expect(parsed.ok, `${verb} must be answered rather than unknown`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe('unsupported-verb');
      // The sentence says where the verb belongs, which is what an agent needs in order to route itself.
      expect(parsed.detail).toContain(verb);
      answered += 1;
    }
    expect(answered).toBeGreaterThan(0);
  });

  it('leaves the dispatcher containment rule exactly where it was', async () => {
    const w = await world(900);
    const task = await w.seed('Contained', 0);
    const beforeFiles = await w.fileNames();
    const beforeRevisions = await w.revisionMap();

    const dispatcher = createActionDispatcher({
      state: w.cockpit.state,
      problems: [],
      revisions: {},
      mode: 'fixture',
      clock: fixedClock(CLOCK_ISO),
      idGenerator: sequentialIdGenerator(),
    });
    const beforeRevision = dispatcher.snapshot().stateRevision;

    for (const action of [
      // The protocol's own wire shape for this verb: a task, a target column and an index - no revision,
      // because a dispatcher that cannot write a record has nothing to write it against.
      { type: 'task.execution.move', taskId: task.id, targetColumn: 'running', targetIndex: 0 },
      { type: 'project.create', name: 'Unavailable', description: '' },
    ]) {
      const result = dispatcher.dispatch(action);
      expect(result).toMatchObject({ ok: false, outcome: 'unavailable', error: { code: 'action-not-available' } });
      expect(result.stateRevision).toBe(beforeRevision);
    }

    // The wire is additive: the verb the protocol refuses is the one the agent can run, and the
    // dispatcher's refusal left the store exactly as it was.
    expect(await w.fileNames()).toEqual(beforeFiles);
    expect(await w.revisionMap()).toEqual(beforeRevisions);

    const accepted = await submitAgentWrite(w.agent, {
      type: 'task.execution.move',
      taskId: task.id,
      from: 'backlog',
      to: 'running',
      targetIndex: 0,
      expectedRevision: task.source.revision,
    });
    expect(accepted).toMatchObject({ ok: true, actionType: 'task.execution.move' });
    expect((await w.taskNamed('Contained')).status).toBe('running');
  });

  it('converges the open Board and Backlog from an agent write, and shows a UI write to agent inspection', async () => {
    const w = await world(1000);
    const first = await w.seed('Alpha', 0);
    const second = await w.seed('Beta', 1);

    expect(boardColumnCards(await w.board(), 'backlog')).toEqual([first.id, second.id]);
    expect(await w.backlogRows()).toEqual([first.id, second.id]);
    const rendersBefore = w.refreshCount();

    // A reorder is the move the Backlog can show: it lists rows in stored order and draws fields, so the
    // row that changed is the row that moved.
    const submitted = await submitAgentWrite(w.agent, {
      type: 'task.execution.reorder',
      taskId: first.id,
      from: 'backlog',
      to: 'backlog',
      targetIndex: 5,
      expectedRevision: first.source.revision,
    });
    expect(submitted).toMatchObject({ ok: true, refreshed: true });

    // The write converged the cockpit itself: exactly one redraw, caused by the refresh the write asked
    // for, with nothing the test did to prompt it.
    expect(w.refreshCount()).toBe(rendersBefore + 1);

    expect(boardColumnCards(await w.board(), 'backlog')).toEqual([second.id, first.id]);
    expect(await w.backlogRows()).toEqual([second.id, first.id]);
    expect(await w.backlogHtml()).toContain(`data-project-backlog-task-id="${first.id}"`);

    // The status change is visible on the board and to inspection, and the untouched record's revision
    // did not move.
    const firstRevisionAfterReorder = await w.revisionOf(first.id);
    const moved = await submitAgentWrite(w.agent, {
      type: 'task.execution.move',
      taskId: second.id,
      from: 'backlog',
      to: 'finished',
      targetIndex: 0,
      expectedRevision: second.source.revision,
    });
    expect(moved).toMatchObject({ ok: true });
    expect(boardColumnOf(await w.board(), second.id)).toBe('finished');
    expect(await w.revisionOf(first.id)).toBe(firstRevisionAfterReorder);

    const inspected = await w.inspection();
    expect(inspected.board.counts).toEqual({ backlog: 1, running: 0, finished: 1 });
    expect(inspected.recordRevisions.find((record) => record.id === second.id)?.revision)
      .toBe(await w.revisionOf(second.id));

    // The other direction of the same pair: a write the human path made is readable by an agent that only
    // reads the store, with no manual refresh on either side.
    const uiTask = await w.seed('Gamma', 2);
    const uiResult = await w.drop({ taskId: uiTask.id, to: 'running', index: 0 });
    expect(uiResult).toMatchObject({ ok: true });
    const afterUiWrite = await w.inspection();
    expect(afterUiWrite.board.counts).toEqual({ backlog: 1, running: 1, finished: 1 });
    expect(afterUiWrite.recordRevisions.find((record) => record.id === uiTask.id)?.revision)
      .toBe(await w.revisionOf(uiTask.id));
  });

  it('races one record with the UI in both directions, refusing the stale loser explicitly', async () => {
    const agentFirst = await world(1100);
    const racing = await agentFirst.seed('Raced', 0);
    const staleProjection = agentFirst.cockpit.state;

    const acceptedByAgent = await submitAgentWrite(agentFirst.agent, {
      type: 'task.execution.move',
      taskId: racing.id,
      from: 'backlog',
      to: 'running',
      targetIndex: 1,
      expectedRevision: racing.source.revision,
    });
    if (!acceptedByAgent.ok) throw new Error('the agent write was refused');
    const winnerRevision = acceptedByAgent.revision;

    // The UI drops from the projection it rendered before the agent's write, so it is the stale caller.
    const staleUi = await agentFirst.drop({ taskId: racing.id, to: 'finished', index: 0, rendered: staleProjection });

    expect(staleUi).toMatchObject({
      ok: false,
      outcome: 'refused',
      actionType: 'task.execution.move',
      reason: 'stale-revision',
      actualRevision: winnerRevision,
      refreshed: true,
    });
    expect((await agentFirst.taskNamed('Raced')).status).toBe('running');
    expect(await agentFirst.revisionOf(racing.id)).toBe(winnerRevision);
    expect(agentFirst.audit.events.at(-1)).toMatchObject({ outcome: 'rejected', errorCode: 'stale-revision' });

    const uiFirst = await world(1200);
    const raced = await uiFirst.seed('Raced', 0);
    const beforeUiWrite = uiFirst.cockpit.state;
    const uiAccepted = await uiFirst.drop({ taskId: raced.id, to: 'running', index: 1 });
    expect(uiAccepted).toMatchObject({ ok: true });
    const uiRevision = uiAccepted.revision as string;

    // Now the agent is the stale caller, holding the revision it read before the human's gesture.
    const staleAgent = await submitAgentWrite(uiFirst.agent, {
      type: 'task.execution.move',
      taskId: raced.id,
      from: 'backlog',
      to: 'finished',
      targetIndex: 0,
      expectedRevision: raced.source.revision,
    });
    expect(staleAgent).toMatchObject({
      ok: false,
      outcome: 'refused',
      actionType: 'task.execution.move',
      reason: 'stale-revision',
      actualRevision: uiRevision,
      refreshed: true,
    });
    expect((await uiFirst.taskNamed('Raced')).status).toBe('running');
    expect(await uiFirst.revisionOf(raced.id)).toBe(uiRevision);
    expect(uiFirst.audit.events.at(-1)).toMatchObject({ outcome: 'rejected', errorCode: 'stale-revision' });
    // The projection the loser rendered from is still what it was: nothing was merged into it.
    expect(beforeUiWrite.tasks.find((task) => task.id === raced.id)?.status).toBe('backlog');
  });
});
