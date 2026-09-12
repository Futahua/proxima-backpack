// @vitest-environment happy-dom
/**
 * Stage 19's "relation/schema changes reproject the Backlog without a restart", closed on the machinery
 * that unblocked it.
 *
 * The box's own note said what was missing: "the Backlog already draws a column per declared property on
 * every render, so reprojection is structural — but the schema it reads is canonical record data: the
 * legacy reader returns `taskSchema: []` ... Closes when a schema record can change at runtime." Schema
 * records can change at runtime now (`src/app/propertySchemaMutations.ts`), so the claim is testable.
 *
 * Two rules the test had to learn from the renderer rather than assume. A property column is drawn for a
 * property **some task actually has** (`src/app/backlogView.ts`, `columnsFor`), not merely because a schema
 * exists — so the card carries a value before the column is expected. And the value keys by the schema's
 * **id**, which is why renaming the property moves the column's label while the stored value stays put:
 * that pair is the box's claim seen from both sides.
 *
 * "Without a restart" is the point rather than a detail: the same source object is loaded for every step and
 * the same renderer is called each time, with no new session, controller or process in between.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonRecordStore } from '../src/app/canonicalRecordCodec.js';
import { createRecordMutationCoordinator } from '../src/app/recordMutation.js';
import {
  createPropertySchema,
  updatePropertySchema,
  type PropertySchemaMutationDependencies,
} from '../src/app/propertySchemaMutations.js';
import { updateTask, type TaskMutationDependencies } from '../src/app/taskMutations.js';
import { recordStoreStateSource } from '../src/app/stateSource.js';
import { createDurableRecoveryStore, type RecoveryJournalBackend } from '../src/app/vaultRecovery.js';
import { fixedClock } from '../src/domain/clock.js';
import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import { opaqueSchemaOptionIdFromRandomBytes } from '../src/domain/canonicalSchema.js';
import type { CanonicalRecordV2 } from '../src/domain/canonicalRecordV2.js';
import { EMPTY_PROJECT_BACKLOG_VIEW, renderProjectBacklog } from '../src/browser/projectBacklog.js';
import { MemoryRecordFiles } from './test-record-store.js';

const CLOCK_ISO = '2026-09-12T10:00:00+07:00';

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

const PROJECT = idFromLastByte(1);
const TASK = idFromLastByte(2);

interface Loaded {
  state: Awaited<ReturnType<ReturnType<typeof recordStoreStateSource>['load']>>['state'];
}

async function world(): Promise<{
  deps: PropertySchemaMutationDependencies;
  taskDeps: TaskMutationDependencies;
  load: () => Promise<Loaded>;
}> {
  const files = new MemoryRecordFiles();
  const store = createCanonicalJsonRecordStore(files);
  const recovery = createDurableRecoveryStore(new MemoryJournal());
  await recovery.load();
  const coordinator = createRecordMutationCoordinator({
    backend: files,
    recovery,
    clock: fixedClock(CLOCK_ISO),
    ids: { next: (prefix = 'id') => `${prefix}-request` },
  });
  let nextId = 40;
  let nextOption = 90;
  const allocateRecordId = (): OpaqueRecordId => idFromLastByte(nextId++);
  const taskDeps: TaskMutationDependencies = {
    store,
    coordinator,
    clock: fixedClock(CLOCK_ISO),
    allocateRecordId,
  };
  const deps: PropertySchemaMutationDependencies = {
    store,
    coordinator,
    allocateRecordId,
    allocateOptionId: () => opaqueSchemaOptionIdFromRandomBytes((() => {
      const bytes = new Uint8Array(16);
      bytes[15] = nextOption++;
      return bytes;
    })()),
  };

  const project = {
    ...defineCanonicalRecordHeader({ kind: 'project', id: PROJECT, name: 'Project' }),
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    archivedAt: null,
    artifactBindings: [],
  };
  const task = {
    ...defineCanonicalRecordHeader({ kind: 'task', id: TASK, name: 'A task' }),
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
  };
  for (const record of [project, task] as CanonicalRecordV2[]) {
    expect((await store.createIfAbsent(record)).ok).toBe(true);
  }

  // One source object, loaded repeatedly: that is what "without a restart" means here.
  const source = recordStoreStateSource(store);
  return { deps, taskDeps, load: async () => await source.load() };
}

function draw(state: Loaded['state']): string {
  return renderProjectBacklog(state, state.projects[0]!, {
    ...EMPTY_PROJECT_BACKLOG_VIEW,
    projectId: PROJECT,
  });
}

describe('Stage 19 schema reprojection', () => {
  it('draws a column for a schema created at runtime, and follows the property when it is renamed', async () => {
    const app = await world();

    const first = await app.load();
    expect(draw(first.state)).not.toContain('Effort');

    // A schema is written over the real store, with no new session, controller or process.
    const created = await createPropertySchema(app.deps, {
      name: 'Effort',
      definition: { type: 'number' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const second = await app.load();
    expect(second.state.taskSchema?.map((schema) => schema.name)).toContain('Effort');
    // The schema alone draws no column — the rule is one column per property some task *has* — so the
    // claim starts where a reader would see it: the card carries a value for the new property.
    const valued = await updateTask(app.taskDeps, {
      taskId: TASK,
      expectedRevision: (await app.load()).state.tasks[0]!.source.revision,
      mutations: [{ kind: 'property', key: created.recordId, value: { type: 'number', value: 3 } }],
    });
    expect(valued.ok).toBe(true);

    const third = await app.load();
    const afterValue = draw(third.state);
    expect(afterValue).toContain('Effort');

    // And a *change* to the schema reprojects too: the column's label follows the record, while the stored
    // value stays keyed by the schema's identity.
    const renamed = await updatePropertySchema(app.deps, {
      schemaId: created.recordId,
      expectedRevision: created.revision,
      name: 'Story points',
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;

    const fourth = await app.load();
    const afterRename = draw(fourth.state);
    expect(afterRename).toContain('Story points');
    expect(afterRename).not.toContain('Effort');
    // The readable projection flattens a stored value to its plain form, keyed by the schema id.\n    expect(fourth.state.tasks[0]!.properties[created.recordId]).toBe(3);
    expect(fourth.state.taskSchema?.map((schema) => schema.name)).toEqual(['Story points']);
  });
});
