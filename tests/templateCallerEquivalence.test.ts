// @vitest-environment happy-dom
/**
 * The two callers of `template.execute`, compared - which is what the Stage 17 equivalence box is about.
 *
 * The AUTHOR narrowed that box on 2026-09-12: it sits beside *agent invocation* and *UI invocation*, so its
 * claim is equivalence between those two callers rather than between the executor and the action that wraps
 * it. (The manual-versus-template comparison at the record level is Stage 16's box, where it stays.) So this
 * runs the same template twice in two isolated stores - once by clicking the composer's Execute button
 * through the real listener, once by submitting the agent wire shape through `submitTemplateExecution` - and
 * compares what the two callers report and what the two stores hold.
 *
 * What is compared is deliberately the caller-visible truth, not the plumbing: the outcome each caller would
 * report (clean, or partial with a sentence), and the decoded canonical task records with identity and
 * timestamps normalised away, which is what D69 says an equivalence must be judged on.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import {
  createTask,
  TASK_MUTATION_SCHEMA_VERSION,
  type CreateTaskRequest,
  type TaskMutationDependencies,
  type TaskMutationResult,
} from '../src/app/taskMutations.js';
import type { TemplateExecuteDependencies } from '../src/app/templateExecuteAction.js';
import { submitTemplateExecution } from '../src/app/templateSubmission.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import { renderTemplateComposerPanel, type TemplateComposerResult } from '../src/browser/templateComposerPanel.js';
import { bindTemplateExecuteInteractions } from '../src/browser/templateExecuteBinding.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T03:00:00+07:00';
const TEMPLATE = [
  'Write the brief',
  '  weight: 3',
  '  start: 2026-09-01',
  '  deadline: 2026-09-30',
  'Draft the outline',
].join('\n');

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function idFor(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[14] = 0x9c;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

async function settle(condition: () => boolean, label = 'the run'): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface WorldOptions {
  readonly template?: string;
  /** Refuse the nth create instead of writing it, so both callers meet the same failure. */
  readonly refuseOn?: number;
}

interface World {
  readonly actionDeps: (render: () => void) => TemplateExecuteDependencies;
  readonly taskIds: () => Promise<readonly string[]>;
  readonly records: () => Promise<unknown[]>;
}

function buildWorld(options: WorldOptions = {}): World {
  const files = new MemoryRecordFiles();
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: sequentialIdGenerator(),
  });
  const store = createCanonicalJsonRecordStore(files);
  let serial = 0;
  const dependencies: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId: () => idFor((serial += 1)),
  };
  let creates = 0;

  const operations = {
    async createTask(request: CreateTaskRequest): Promise<TaskMutationResult> {
      creates += 1;
      if (options.refuseOn === creates) {
        return {
          ok: false,
          schemaVersion: TASK_MUTATION_SCHEMA_VERSION,
          reason: 'storage-failure',
          detail: 'the backend refused this write',
        };
      }
      return await createTask(dependencies, request);
    },
  };

  return {
    actionDeps: (render) => ({
      state: null,
      writes: async () => operations,
      unavailableReason: () => 'writes-unavailable',
      refresh: async () => null,
      setRefusal: () => {},
      render,
      ids: semanticIds(),
      audit: recordingAudit(),
    }),
    taskIds: async () => (await store.list())
      .filter((observation) => observation.kind === 'task')
      .map((observation) => observation.record.id)
      .sort(),
    records: async () => (await store.list())
      .filter((observation) => observation.kind === 'task')
      .map((observation) => normalise(observation.record)),
  };
}

/** The caller a person is: the real composer, the real listener, one click. */
async function throughTheClick(options: WorldOptions = {}): Promise<{
  readonly outcome: TemplateComposerResult;
  readonly taskIds: readonly string[];
  readonly records: readonly unknown[];
}> {
  const world = buildWorld(options);
  const template = options.template ?? TEMPLATE;
  const host = document.createElement('div');
  document.body.append(host);

  const view = { executing: false, result: null as TemplateComposerResult | null };
  const draw = (): void => {
    host.innerHTML = renderTemplateComposerPanel({
      text: template,
      open: true,
      active: true,
      executable: true,
      executing: view.executing,
      result: view.result,
    });
  };

  bindTemplateExecuteInteractions(host, {
    template: () => template,
    action: () => world.actionDeps(draw),
    begin: () => { view.executing = true; view.result = null; },
    finish: (result) => { view.executing = false; view.result = result; },
  });
  draw();

  createInteractionHarness(host).click('template-execute');
  await settle(() => view.result !== null);

  if (view.result === null) throw new Error('the click produced no outcome');
  return { outcome: view.result, taskIds: await world.taskIds(), records: await world.records() };
}

/** The caller an agent is: the submission entry, with no panel anywhere in the dependency set. */
async function throughTheSubmission(options: WorldOptions = {}): Promise<{
  readonly outcome: Extract<Awaited<ReturnType<typeof submitTemplateExecution>>, { verb: 'execute' }>;
  readonly taskIds: readonly string[];
  readonly records: readonly unknown[];
}> {
  const world = buildWorld(options);
  const result = await submitTemplateExecution(world.actionDeps(() => {}), {
    type: 'template.execute',
    template: options.template ?? TEMPLATE,
  });
  if (!('verb' in result)) throw new Error(`the submission was rejected before execution: ${result.detail}`);
  return { outcome: result, taskIds: await world.taskIds(), records: await world.records() };
}

/** The keys identity and time are allowed to differ on, per D69. */
const NORMALISED_AWAY = new Set(['id', 'createdAt', 'revision', 'revisions', 'observedRevision']);

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !NORMALISED_AWAY.has(key))
        .map(([key, entry]) => [key, normalise(entry)]),
    );
  }
  return value;
}

function multiset(values: readonly unknown[]): string[] {
  return values.map((value) => JSON.stringify(value)).sort();
}

describe('the UI caller and the agent caller of template.execute (D71)', () => {
  it('creates the same records from the same template', async () => {
    const clicked = await throughTheClick();
    const submitted = await throughTheSubmission();

    expect(clicked.outcome.failure).toBeNull();
    expect(submitted.outcome.ok).toBe(true);
    expect(clicked.outcome.created).toHaveLength(2);
    expect(submitted.outcome.created).toHaveLength(2);

    // Each caller's reported ids are the records that actually landed in its own store.
    expect([...clicked.outcome.created].sort()).toEqual([...clicked.taskIds]);
    expect([...submitted.outcome.created].sort()).toEqual([...submitted.taskIds]);

    expect(multiset(submitted.records)).toEqual(multiset(clicked.records));
  });

  it('agrees when the run stops part-way, including the sentence it reports', async () => {
    const clicked = await throughTheClick({ refuseOn: 2 });
    const submitted = await throughTheSubmission({ refuseOn: 2 });

    expect(clicked.outcome.created).toHaveLength(1);
    expect(clicked.outcome.failure).not.toBeNull();
    expect(submitted.outcome.ok).toBe(false);
    expect(submitted.outcome.created).toHaveLength(1);
    // The panel's sentence is the action's own refusal detail, so the two callers say the same thing.
    if (submitted.outcome.ok) throw new Error('the submission reported success after a refused write');
    expect(clicked.outcome.failure).toBe(submitted.outcome.detail);

    expect(multiset(submitted.records)).toEqual(multiset(clicked.records));
  });

  it('would notice a difference the normalisation does not hide', async () => {
    // The control: the comparisons above only mean something if a real difference survives normalisation.
    const clicked = await throughTheClick();
    const submitted = await throughTheSubmission({ template: `${TEMPLATE}\nReview the outline` });

    expect(multiset(submitted.records)).not.toEqual(multiset(clicked.records));
  });
});
