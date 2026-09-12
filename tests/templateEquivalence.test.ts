/**
 * D69: the manual-versus-template equivalence, judged on records rather than on requests.
 *
 * The AUTHOR ruled on 2026-09-12 that equal request lists prove only compilation parity, while the
 * checklist's claim is about the records that result. So this runs the same three tasks twice - once by
 * calling the ordinary create path directly, once by executing a template - in two isolated stores, and
 * compares the decoded canonical task records.
 *
 * The template side goes through `executeTemplateAction`, which is the entry the panel Confirm and an
 * agent submission both call, rather than through the executor underneath it. An equivalence asserted
 * against a function a shipped path could bypass would be a comparison of two things nobody does; this
 * one is between the manual path and the path that actually runs. The executor keeps its own coverage
 * in `tests/templateExecution.test.ts`.
 *
 * What is normalised away is exactly what the ruling names: `id`, `createdAt`, and the store/observation
 * revisions. Identity and timestamps are deliberately allowed to differ, which is why the acceptance does
 * not rest on the two runs coincidentally generating the same bytes. Every semantic field stays compared,
 * including the ones neither run sets explicitly - a field that exists only in one of the two paths shows
 * up as a difference rather than being filtered out.
 */
import { describe, expect, it } from 'vitest';

import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import { createTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { executeTemplateAction, type TemplateExecuteDependencies } from '../src/app/templateExecuteAction.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T03:00:00+07:00';

/** Deterministic, distinct, and the real opaque form: sixteen bytes, so the id is a valid record id. */
function idFor(serial: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[14] = 0x9a;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

class MemoryJournal implements RecoveryJournalBackend {
  text: string | undefined;

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(value: string): Promise<void> {
    this.text = value;
  }
}

function harness(): { deps: TaskMutationDependencies; store: ReturnType<typeof createCanonicalJsonRecordStore> } {
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
  return {
    store,
    deps: {
      store,
      coordinator,
      clock: fixedClock(CLOCK_ISO),
      allocateRecordId: () => idFor((serial += 1)),
    },
  };
}

/**
 * The action's dependencies, in the shape the shell resolves them: the operations structurally, and the
 * surface hooks recorded rather than drawn. The refresh declines, which is a state the action already
 * answers (`refreshed: false`) and which keeps this test about records rather than about redraws.
 */
function actionDeps(h: ReturnType<typeof harness>): TemplateExecuteDependencies {
  return {
    state: null,
    writes: async () => ({ createTask: (request) => createTask(h.deps, request) }),
    unavailableReason: () => null,
    refresh: async () => null,
    setRefusal: () => {},
    render: () => {},
    ids: semanticIds(),
    audit: recordingAudit(),
  };
}

/** The keys the ruling says may differ between the two runs. */
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

async function taskRecords(store: ReturnType<typeof createCanonicalJsonRecordStore>): Promise<unknown[]> {
  const observations = await store.list();
  return observations
    .filter((observation) => observation.kind === 'task')
    .map((observation) => normalise(observation.record));
}

/** A multiset comparison: order of creation is not a semantic field. */
function multiset(values: unknown[]): string[] {
  return values.map((value) => JSON.stringify(value)).sort();
}

const TEMPLATE = [
  'Write the brief',
  '  weight: 3',
  '  start: 2026-09-01',
  '  deadline: 2026-09-30',
  '  fixed: 45',
  '  max: 90',
  'Draft the outline',
  '  weight: 1',
  'Review the outline',
].join('\n');

describe('manual and template creation produce the same records (D69)', () => {
  it('agrees on the decoded canonical task records', async () => {
    const manual = harness();
    const manualRequests = [
      {
        name: 'Write the brief',
        projectId: null,
        weight: 3,
        startDate: '2026-09-01',
        deadline: '2026-09-30',
        isFixedDuration: true,
        fixedDuration: 45,
        maxDuration: 90,
      },
      { name: 'Draft the outline', projectId: null, weight: 1, startDate: null, deadline: null },
      { name: 'Review the outline', projectId: null, startDate: null, deadline: null },
    ];
    for (const request of manualRequests) {
      const result = await createTask(manual.deps, request);
      expect(result.ok).toBe(true);
    }

    const viaTemplate = harness();
    const outcome = await executeTemplateAction(actionDeps(viaTemplate), { template: TEMPLATE });
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toHaveLength(3);

    const manualRecords = await taskRecords(manual.store);
    const templateRecords = await taskRecords(viaTemplate.store);

    expect(manualRecords).toHaveLength(3);
    expect(templateRecords).toHaveLength(3);
    expect(multiset(templateRecords)).toEqual(multiset(manualRecords));
  });

  it('would notice a difference the normalisation does not hide', async () => {
    // The control: the two runs above are only equal if every semantic field matches, so a deliberate
    // difference in one of them must survive normalisation and fail the comparison.
    const manual = harness();
    await createTask(manual.deps, { name: 'Write the brief', projectId: null, weight: 3 });
    const viaTemplate = harness();
    await createTask(viaTemplate.deps, { name: 'Write the brief', projectId: null, weight: 5 });

    expect(multiset(await taskRecords(viaTemplate.store)))
      .not.toEqual(multiset(await taskRecords(manual.store)));
  });
});
