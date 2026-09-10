import { describe, expect, it } from 'vitest';
import {
  CANONICAL_RECORD_SCHEMA_VERSION,
  defineCanonicalRecordHeader,
  defineLegacyImportProvenance,
  indexCanonicalRecords,
  opaqueRecordIdFromRandomBytes,
  pairCanonicalWithLegacyProvenance,
  parseOpaqueRecordId,
  type CanonicalRecordKind,
} from '../src/domain/canonicalIdentity.js';

function idFromLastByte(value: number) {
  const bytes = new Uint8Array(16);
  bytes[15] = value;
  return opaqueRecordIdFromRandomBytes(bytes);
}

describe('HARD GATE A / A1 canonical opaque identity', () => {
  it('uses an opaque format that does not accept legacy ids and needs exactly 128 random bits', () => {
    const id = idFromLastByte(1);

    expect(id).toBe('pxr_00000000000000000000000000000001');
    expect(parseOpaqueRecordId(id)).toBe(id);
    expect(() => parseOpaqueRecordId('task-1757004')).toThrow(
      /Invalid opaque Proxima record id/,
    );
    expect(() => opaqueRecordIdFromRandomBytes(new Uint8Array(15))).toThrow(
      /exactly 16 random bytes/,
    );
  });

  it('gives every future canonical record kind the same versioned opaque-id contract', () => {
    const kinds: readonly CanonicalRecordKind[] = [
      'task',
      'project',
      'event',
      'schema',
      'workflow-stage',
    ];

    const records = kinds.map((kind, index) =>
      defineCanonicalRecordHeader({
        kind,
        id: idFromLastByte(index + 1),
        name: `${kind} display name`,
      }),
    );

    expect(records.map((record) => record.kind)).toEqual(kinds);
    expect(records.every((record) => record.schemaVersion === CANONICAL_RECORD_SCHEMA_VERSION))
      .toBe(true);
    expect(new Set(records.map((record) => record.id)).size).toBe(kinds.length);
  });

  it('keeps canonical identity stable when the human-facing name changes', () => {
    const original = defineCanonicalRecordHeader({
      kind: 'task',
      id: idFromLastByte(1),
      name: 'First display name',
    });
    const renamed = {
      ...original,
      name: 'Renamed display name',
    };

    expect(renamed.id).toBe(original.id);
    expect(renamed.kind).toBe(original.kind);
    expect(renamed.name).not.toBe(original.name);
  });

  it('keeps physical storage filename outside domain identity and looks records up only by id', () => {
    const record = defineCanonicalRecordHeader({
      kind: 'project',
      id: idFromLastByte(2),
      name: 'Project',
    });

    const firstPlacement = {
      filename: 'human-readable-name.json',
      record,
    };
    const movedPlacement = {
      ...firstPlacement,
      filename: 'completely-different-storage-name.json',
    };

    const index = indexCanonicalRecords([movedPlacement.record]);

    expect(index.get(record.id)).toBe(record);
    expect(movedPlacement.record.id).toBe(firstPlacement.record.id);
    expect(record).not.toHaveProperty('filename');
    expect(record).not.toHaveProperty('sourcePath');
  });

  it('allows duplicate display names because names are not identity', () => {
    const first = defineCanonicalRecordHeader({
      kind: 'event',
      id: idFromLastByte(3),
      name: 'Same name',
    });
    const second = defineCanonicalRecordHeader({
      kind: 'event',
      id: idFromLastByte(4),
      name: 'Same name',
    });

    const index = indexCanonicalRecords([first, second]);

    expect(first.name).toBe(second.name);
    expect(first.id).not.toBe(second.id);
    expect(index.get(first.id)).toBe(first);
    expect(index.get(second.id)).toBe(second);
  });

  it('refuses duplicate canonical ids even when every other field differs', () => {
    const id = idFromLastByte(5);
    const first = defineCanonicalRecordHeader({
      kind: 'task',
      id,
      name: 'One',
    });
    const second = defineCanonicalRecordHeader({
      kind: 'project',
      id,
      name: 'Two',
    });

    expect(() => indexCanonicalRecords([first, second])).toThrow(
      `Duplicate canonical record id: ${id}`,
    );
  });

  it('keeps legacy frontmatter, filename and folder ids only as import provenance', () => {
    const record = defineCanonicalRecordHeader({
      kind: 'task',
      id: idFromLastByte(6),
      name: 'Renamed by hand',
    });
    const provenance = defineLegacyImportProvenance(
      '-Hide/Proxima/tasks/Renamed by hand.md',
      [
        { value: 'task-1757004', origin: 'frontmatter' },
        { value: 'Renamed by hand', origin: 'filename' },
        { value: 'legacy-folder-name', origin: 'folder' },
      ],
    );

    const assignment = pairCanonicalWithLegacyProvenance(record, provenance);

    expect(assignment.record.id).toBe(record.id);
    expect(assignment.record).not.toHaveProperty('sourcePath');
    expect(assignment.provenance.sourcePath).toBe(
      '-Hide/Proxima/tasks/Renamed by hand.md',
    );
    expect(assignment.provenance.aliases).toEqual([
      { value: 'task-1757004', origin: 'frontmatter' },
      { value: 'Renamed by hand', origin: 'filename' },
      { value: 'legacy-folder-name', origin: 'folder' },
    ]);
    expect(assignment.provenance.aliases.map((alias) => alias.value))
      .not.toContain(record.id);
  });

  it('refuses silent promotion even when a legacy explicit id already looks opaque', () => {
    const id = idFromLastByte(7);
    const record = defineCanonicalRecordHeader({
      kind: 'schema',
      id,
      name: 'Priority',
    });
    const provenance = defineLegacyImportProvenance(
      'Proxima/schema/Priority.md',
      [{ value: id, origin: 'frontmatter' }],
    );

    expect(() => pairCanonicalWithLegacyProvenance(record, provenance)).toThrow(
      /Legacy identity aliases are provenance only/,
    );
  });
});
