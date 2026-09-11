import { describe, expect, it } from 'vitest';
import {
  defineCanonicalRecordHeader,
  defineLegacyImportProvenance,
  opaqueRecordIdFromRandomBytes,
  pairCanonicalWithLegacyProvenance,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import type { CanonicalTaskStateRecord } from '../src/domain/canonicalTaskState.js';

function recordId(value: number): OpaqueRecordId {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

describe('HARD GATE A / A7 name and storage separation', () => {
  it('keeps task, project and event titles as ordinary canonical fields', () => {
    const title = 'One ordinary human title';
    const task = defineCanonicalRecordHeader({ kind: 'task', id: recordId(1), name: title });
    const project = defineCanonicalRecordHeader({ kind: 'project', id: recordId(2), name: title });
    const event = defineCanonicalRecordHeader({ kind: 'event', id: recordId(3), name: title });
    expect([task.name, project.name, event.name]).toEqual([title, title, title]);
    expect(new Set([task.id, project.id, event.id]).size).toBe(3);
  });

  it('accepts titles that would be unsuitable as storage filenames without deriving storage', () => {
    const title = 'Q4: plan / draft \\ * ? " < > | # [review]';
    const record = defineCanonicalRecordHeader({ kind: 'project', id: recordId(4), name: title });
    expect(record.name).toBe(title);
    expect(record).not.toHaveProperty('filename');
    expect(record).not.toHaveProperty('path');
    expect(record).not.toHaveProperty('sourcePath');
  });

  it('does not apply YAML quoting, colon or comment syntax to canonical titles', () => {
    const titles = ['status: [ready, later]', '"quoted": value # this remains title text', 'line one\nline two: still ordinary title data'];
    const records = titles.map((name, index) => defineCanonicalRecordHeader({ kind: 'event', id: recordId(10 + index), name }));
    expect(records.map((record) => record.name)).toEqual(titles);
  });

  it('keeps canonical name and identity unchanged when legacy storage representation moves', () => {
    const record = defineCanonicalRecordHeader({ kind: 'task', id: recordId(20), name: 'Human: title / independent from file' });
    const beforeMove = pairCanonicalWithLegacyProvenance(record, defineLegacyImportProvenance('Proxima/tasks/Old filename.md', [{ value: 'legacy-task-name', origin: 'filename' }]));
    const afterMove = pairCanonicalWithLegacyProvenance(record, defineLegacyImportProvenance('Archive/renamed/New filename entirely.md', [{ value: 'legacy-task-name', origin: 'filename' }]));
    expect(beforeMove.provenance.sourcePath).not.toBe(afterMove.provenance.sourcePath);
    expect(afterMove.record.id).toBe(beforeMove.record.id);
    expect(afterMove.record.name).toBe(beforeMove.record.name);
  });

  it('round-trips structured canonical task data through JSON without source-syntax rules', () => {
    const title = 'Review: "alpha" # literal\nnext line: [one, two]';
    const task: CanonicalTaskStateRecord = {
      ...defineCanonicalRecordHeader({ kind: 'task', id: recordId(30), name: title }),
      projectId: recordId(31),
      executionState: 'running',
      workflowStageId: recordId(32),
    };
    const encoded = JSON.stringify(task);
    const decoded = JSON.parse(encoded) as Record<string, unknown>;
    expect(decoded).toEqual(task);
    expect(decoded.name).toBe(title);
    expect(decoded.executionState).toBe('running');
    expect(decoded.workflowStageId).toBe(task.workflowStageId);
  });
});
