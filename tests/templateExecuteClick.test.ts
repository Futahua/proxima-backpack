// @vitest-environment happy-dom
/**
 * The composer's Execute button, clicked, with the listener the shell actually binds.
 *
 * This is the box the browser AUTHOR reopened on 2026-09-12: no test clicked `template-execute` and watched
 * the action run, because `src/browser/main.ts` composes on import and cannot be imported by a test. The
 * binding now lives in `src/browser/templateExecuteBinding.ts`, so this file can render the real composer,
 * bind the real listener, click the machine key the panel declares, and observe what the shell would see:
 * the run in flight, the result, the records, and the source refresh a write owes.
 *
 * What is asserted is the chain rather than a description of it - the records exist in a real store after the
 * click, the ids the panel reports are the ids that landed, a second click during a run does not double the
 * tasks, and a refusal leaves the composer open with the template still in it.
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
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { createInteractionHarness } from '../src/browser/interactionHarness.js';
import {
  renderTemplateComposerPanel,
  TEMPLATE_EXECUTE_RUNNING_NOTE,
  type TemplateComposerResult,
} from '../src/browser/templateComposerPanel.js';
import { bindTemplateExecuteInteractions } from '../src/browser/templateExecuteBinding.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T03:00:00+07:00';
const TEMPLATE = ['Write the brief', '  weight: 3', 'Draft the outline'].join('\n');

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
  bytes[14] = 0x9b;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

/** Wait for the run to reach a state, rather than for a fixed number of ticks. */
async function settle(condition: () => boolean, label = 'the run'): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface WorldOptions {
  /** Refuse the nth create instead of writing it, standing in for any failure the port can report. */
  readonly refuseOn?: number;
  /** What the operations do before the first write, so a run can be observed while it is in flight. */
  readonly beforeCreate?: () => Promise<void>;
  /** Report no write path at all, which is a refusal before the first call rather than a failed write. */
  readonly writesUnavailable?: boolean;
}

interface World {
  readonly operations: { createTask(request: CreateTaskRequest): Promise<TaskMutationResult> };
  readonly writes: () => Promise<World['operations'] | null>;
  readonly creates: () => number;
  readonly taskIds: () => Promise<readonly string[]>;
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
      await options.beforeCreate?.();
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
    operations,
    writes: async () => (options.writesUnavailable === true ? null : operations),
    creates: () => creates,
    taskIds: async () => {
      const observations = await store.list();
      return observations
        .filter((observation) => observation.kind === 'task')
        .map((observation) => observation.record.id)
        .sort();
    },
  };
}

interface Mounted {
  readonly host: HTMLElement;
  readonly harness: ReturnType<typeof createInteractionHarness>;
  readonly view: { executing: boolean; result: TemplateComposerResult | null };
  readonly world: World;
  readonly afterRuns: () => number;
}

/** The composer, bound the way the shell binds it: the panel rendered, the listener attached to the root. */
function mount(options: WorldOptions = {}): Mounted {
  const world = buildWorld(options);
  const host = document.createElement('div');
  document.body.append(host);

  const view = { executing: false, result: null as TemplateComposerResult | null };
  const draw = (): void => {
    host.innerHTML = renderTemplateComposerPanel({
      text: TEMPLATE,
      open: true,
      active: true,
      executable: true,
      executing: view.executing,
      result: view.result,
    });
  };

  let afterRuns = 0;
  const action: TemplateExecuteDependencies = {
    state: null,
    writes: world.writes,
    unavailableReason: () => 'writes-unavailable',
    refresh: async () => null,
    setRefusal: () => {},
    render: draw,
    ids: semanticIds(),
    audit: recordingAudit(),
  };

  bindTemplateExecuteInteractions(host, {
    template: () => TEMPLATE,
    action: () => action,
    begin: () => { view.executing = true; view.result = null; },
    finish: (result) => { view.executing = false; view.result = result; },
    afterRun: () => { afterRuns += 1; },
  });
  draw();

  return { host, harness: createInteractionHarness(host), view, world, afterRuns: () => afterRuns };
}

describe('the composer Execute button, clicked', () => {
  it('runs the action, creates the records, and reports the ids that landed', async () => {
    const mounted = mount();
    mounted.harness.click('template-execute');
    await settle(() => mounted.view.result !== null);

    const landed = await mounted.world.taskIds();
    expect(landed).toHaveLength(2);
    expect(mounted.view.result?.failure).toBeNull();
    expect([...(mounted.view.result?.created ?? [])].sort()).toEqual([...landed]);

    // The panel says what happened, and stays open with the template rather than closing over the result.
    expect(mounted.host.querySelector('[data-template-result-created]')?.getAttribute('data-template-result-created')).toBe('2');
    expect(mounted.host.querySelector('[data-template-composer]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-template-text]')?.textContent).toContain('Write the brief');
    // A write owes a re-read, and the shell's half of that ran.
    expect(mounted.afterRuns()).toBe(1);
  });

  it('says the run is in flight while it is, and reports the result when it lands', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mounted = mount({ beforeCreate: async () => { await gate; } });

    mounted.harness.click('template-execute');
    await settle(() => mounted.view.executing);
    expect(mounted.view.result).toBeNull();
    expect(mounted.host.querySelector('[data-template-execute-refusal]')?.getAttribute('data-template-execute-refusal'))
      .toBe('action-in-flight');
    expect(mounted.host.textContent).toContain(TEMPLATE_EXECUTE_RUNNING_NOTE);
    expect(await mounted.world.taskIds()).toHaveLength(0);

    release();
    await settle(() => mounted.view.result !== null);
    expect(mounted.view.result?.created).toHaveLength(2);
    expect(await mounted.world.taskIds()).toHaveLength(2);
  });

  it('does not create the tasks twice when the button is clicked again mid-run', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mounted = mount({ beforeCreate: async () => { await gate; } });

    mounted.harness.click('template-execute');
    await settle(() => mounted.view.executing);
    mounted.harness.click('template-execute');
    release();
    await settle(() => mounted.view.result !== null);

    expect(mounted.world.creates()).toBe(2);
    expect(await mounted.world.taskIds()).toHaveLength(2);
  });

  it('reports a refusal with the composer still open and nothing written', async () => {
    const mounted = mount({ writesUnavailable: true });
    mounted.harness.click('template-execute');
    await settle(() => mounted.view.result !== null);

    expect(mounted.world.creates()).toBe(0);
    expect(await mounted.world.taskIds()).toHaveLength(0);
    expect(mounted.view.result?.failure).toBe('writes-unavailable');
    expect(mounted.host.querySelector('[data-template-failure]')?.textContent).toContain('writes-unavailable');
    expect(mounted.host.querySelector('[data-template-composer]')).not.toBeNull();
  });

  it('reports a run that stopped part-way as partial, with the ids that did land', async () => {
    const mounted = mount({ refuseOn: 2 });
    mounted.harness.click('template-execute');
    await settle(() => mounted.view.result !== null);

    const landed = await mounted.world.taskIds();
    expect(landed).toHaveLength(1);
    expect(mounted.view.result?.created).toHaveLength(1);
    expect(mounted.view.result?.failure).toBe('the backend refused this write');
    expect([...(mounted.view.result?.created ?? [])]).toEqual([...landed]);
    const result = mounted.host.querySelector('[data-template-result]');
    expect(result?.getAttribute('data-template-result-partial')).toBe('true');
    expect(result?.getAttribute('data-template-result-created')).toBe('1');
    expect(mounted.host.querySelector('[data-template-failure]')).not.toBeNull();
  });
});
