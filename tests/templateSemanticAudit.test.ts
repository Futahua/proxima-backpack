/**
 * The semantic request envelope and the terminal audit event, asserted on the one family that has them.
 *
 * Stage 17's contract matrix found the same two gaps on all thirty-six rows: no system-generated request id
 * survived into any result, and no write path emitted a semantic event. The AUTHOR scoped the fix on
 * 2026-09-12 as a semantic request envelope plus a semantic terminal event sink - not a redesign of
 * `recordMutation.ts` - and this file is the evidence for the first family wired to it.
 *
 * Four things are being proved, and each is a thing a reader would otherwise have to take on trust:
 *
 * - a run's id is minted at the boundary, so a **refused** run is correlatable as well as an accepted one;
 * - the id is not the coordinator's, and a caller cannot supply one - the request type has no such field, and
 *   a caller that smuggles one in gets the minted id back;
 * - one terminal event is appended per run, **after** convergence, so it can carry the state the surfaces
 *   actually reached;
 * - a partial run is journalled as `partial`, because "one task landed and the second was refused" reported
 *   as an acceptance or a rejection is the lie the panel rule exists to prevent.
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
import {
  executeTemplateAction,
  type TemplateExecuteDependencies,
  type TemplateExecuteRequest,
} from '../src/app/templateExecuteAction.js';
import { SEMANTIC_REQUEST_PREFIX, semanticOutcomeOf } from '../src/app/semanticAudit.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { MemoryRecordFiles } from './test-record-store.js';
import { recordingAudit, semanticIds } from './test-semantic-audit.js';

const CLOCK_ISO = '2026-09-12T11:00:00+07:00';
const TEMPLATE = ['Write the brief', '  weight: 3', 'Draft the outline'].join('\n');
const UNTRANSLATABLE = ['Write the brief', '  status: doing'].join('\n');
const INVALID = ['  weight: 3', 'Write the brief'].join('\n');

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
  bytes[14] = 0x9d;
  bytes[15] = serial;
  return opaqueRecordIdFromRandomBytes(bytes);
}

interface WorldOptions {
  readonly refuseOn?: number;
  readonly available?: boolean;
}

/** A store, the operations a resolved write path hands the action, and the order things happened in. */
function world(options: WorldOptions = {}) {
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

  const audit = recordingAudit();
  const order: string[] = [];
  const renders = { count: 0 };

  const deps: TemplateExecuteDependencies = {
    state: null,
    writes: async () => (options.available === false ? null : operations),
    unavailableReason: () => 'the record store is not open',
    refresh: async () => {
      order.push('refresh');
      return null;
    },
    setRefusal: () => {},
    render: () => { renders.count += 1; },
    ids: semanticIds(),
    audit: {
      append: (event) => {
        order.push(`audit:${event.outcome}`);
        audit.append(event);
      },
    },
  };

  return {
    deps,
    audit,
    order,
    renders: () => renders.count,
    creates: () => creates,
    taskIds: async () => (await store.list())
      .filter((observation) => observation.kind === 'task')
      .map((observation) => observation.record.id)
      .sort(),
  };
}

describe('the semantic request envelope and terminal event (template.execute)', () => {
  it('mints an id at the boundary and journals one acceptance after convergence', async () => {
    const w = world();
    const outcome = await executeTemplateAction(w.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(true);
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(outcome.ok && outcome.created).toHaveLength(2);

    expect(w.audit.events).toHaveLength(1);
    const [event] = w.audit.events;
    expect(event).toMatchObject({
      requestId: outcome.requestId,
      actionType: 'template.execute',
      outcome: 'accepted',
    });
    expect([...event!.entityIds].sort()).toEqual(await w.taskIds());
    expect(event!.errorCode).toBeUndefined();
    // Convergence first, event second: that ordering is what lets the sink journal the state the surfaces
    // have actually reached rather than one guessed at write time.
    expect(w.order).toEqual(['refresh', 'audit:accepted']);
  });

  it('correlates a refused run too, and journals it as a rejection that wrote nothing', async () => {
    const w = world();
    const outcome = await executeTemplateAction(w.deps, { template: INVALID });

    expect(outcome.ok).toBe(false);
    expect(outcome.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.creates()).toBe(0);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'plan-invalid',
    });
    // A refusal decided before the first call changes nothing, so nothing re-read: the convergence rule.
    expect(w.order).toEqual(['audit:rejected']);
  });

  it('journals a refusal the boundary decided, not only a refusal the plan decided', async () => {
    const w = world({ available: false });
    const outcome = await executeTemplateAction(w.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(false);
    expect(w.creates()).toBe(0);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'writes-unavailable',
    });
  });

  it('journals a partial run as partial, with the id that landed and the code that stopped it', async () => {
    const w = world({ refuseOn: 2 });
    const outcome = await executeTemplateAction(w.deps, { template: TEMPLATE });

    expect(outcome.ok).toBe(false);
    const landed = await w.taskIds();
    expect(landed).toHaveLength(1);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      requestId: outcome.requestId,
      outcome: 'partial',
      entityIds: landed,
      // The code is the port's own cause rather than one word for every creation failure: this fixture refuses
      // the second write with `storage-failure`, and the boundary used to flatten that into `creation-refused`,
      // which is the collapse the matrix recorded as two gaps. The event now says which of the three it was.
      errorCode: 'storage-failure',
    });
    // A partial run wrote records, so it converged before the event was appended - and the event is neither
    // of the two outcomes a surface could mistake it for.
    expect(w.order).toEqual(['refresh', 'audit:partial']);
  });

  it('gives every run its own id, and a caller cannot supply one', async () => {
    const w = world();
    const first = await executeTemplateAction(w.deps, { template: TEMPLATE });
    const second = await executeTemplateAction(w.deps, { template: TEMPLATE });

    expect(first.requestId).not.toBe(second.requestId);
    expect(w.audit.events.map((event) => event.requestId)).toEqual([first.requestId, second.requestId]);

    // The request type has no such field, and a caller that smuggles one in is ignored rather than trusted.
    const smuggled = { template: TEMPLATE, requestId: 'caller-supplied' } as unknown as TemplateExecuteRequest;
    const third = await executeTemplateAction(w.deps, smuggled);
    expect(third.requestId).not.toBe('caller-supplied');
    expect(third.requestId.startsWith(SEMANTIC_REQUEST_PREFIX)).toBe(true);
    expect(w.audit.events[2]!.requestId).toBe(third.requestId);
  });

  it('reads the outcome off what a run wrote and whether it stopped, in one place', () => {
    // The rule the family is shared with: a surface that decides this for itself is how a partial run gets
    // reported as an acceptance.
    expect(semanticOutcomeOf({ wrote: 3, refused: false })).toBe('accepted');
    expect(semanticOutcomeOf({ wrote: 0, refused: true })).toBe('rejected');
    expect(semanticOutcomeOf({ wrote: 1, refused: true })).toBe('partial');
  });

  it('refuses a draft field it cannot translate, journalled with its own code', async () => {
    const w = world();
    const outcome = await executeTemplateAction(w.deps, { template: UNTRANSLATABLE });

    expect(outcome.ok).toBe(false);
    expect(w.creates()).toBe(0);
    expect(w.audit.events[0]).toMatchObject({
      outcome: 'rejected',
      entityIds: [],
      errorCode: 'untranslatable-draft-field',
    });
  });
});
