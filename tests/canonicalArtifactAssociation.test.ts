import { describe, expect, it } from 'vitest';
import {
  defineCanonicalRecordHeader,
  opaqueRecordIdFromRandomBytes,
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from '../src/domain/canonicalIdentity.js';
import {
  defineExternalArtifactReference,
  defineProjectArtifactAssociations,
  opaqueExternalArtifactIdFromRandomBytes,
  parseOpaqueExternalArtifactId,
  resolveProjectArtifacts,
  type OpaqueExternalArtifactId,
} from '../src/domain/canonicalArtifactAssociation.js';

function recordId(value: number): OpaqueRecordId { const bytes = new Uint8Array(16); bytes[15] = value; return opaqueRecordIdFromRandomBytes(bytes); }
function artifactId(value: number): OpaqueExternalArtifactId { const bytes = new Uint8Array(16); bytes[15] = value; return opaqueExternalArtifactIdFromRandomBytes(bytes); }

describe('HARD GATE A / A8 explicit project/filesystem association', () => {
  it('explicitly associates one project with notes, drawings, attachments and individual artifacts', () => {
    const projectId = recordId(1);
    const notesRoot = defineExternalArtifactReference({ id: artifactId(1), kind: 'folder', locator: { kind: 'vault-relative-path', path: 'Notes/Shared' } });
    const drawingsRoot = defineExternalArtifactReference({ id: artifactId(2), kind: 'folder', locator: { kind: 'vault-relative-path', path: 'Drawings' } });
    const attachmentsRoot = defineExternalArtifactReference({ id: artifactId(3), kind: 'folder', locator: { kind: 'vault-relative-path', path: 'Attachments' } });
    const note = defineExternalArtifactReference({ id: artifactId(4), kind: 'note', locator: { kind: 'vault-relative-path', path: 'Elsewhere/Project note.md' } });
    const association = defineProjectArtifactAssociations({ projectId, bindings: [{ role: 'notes-root', artifactId: notesRoot.id }, { role: 'drawings-root', artifactId: drawingsRoot.id }, { role: 'attachments-root', artifactId: attachmentsRoot.id }, { role: 'artifact', artifactId: note.id }] });
    expect(resolveProjectArtifacts(association, [notesRoot, drawingsRoot, attachmentsRoot, note]).map(({ role, artifact }) => ({ role, id: artifact.id, path: artifact.locator.path }))).toEqual([{ role: 'notes-root', id: notesRoot.id, path: 'Notes/Shared' }, { role: 'drawings-root', id: drawingsRoot.id, path: 'Drawings' }, { role: 'attachments-root', id: attachmentsRoot.id, path: 'Attachments' }, { role: 'artifact', id: note.id, path: 'Elsewhere/Project note.md' }]);
  });
  it('keeps artifact identity independent when a note moves', () => {
    const project = defineCanonicalRecordHeader({ kind: 'project', id: recordId(10), name: 'Project' });
    const task = defineCanonicalRecordHeader({ kind: 'task', id: recordId(11), name: 'Task' });
    const noteId = artifactId(10);
    const beforeMove = defineExternalArtifactReference({ id: noteId, kind: 'note', locator: { kind: 'vault-relative-path', path: 'Notes/Old location.md' } });
    const afterMove = defineExternalArtifactReference({ id: noteId, kind: 'note', locator: { kind: 'vault-relative-path', path: 'Archive/New location.md' } });
    expect(beforeMove.locator.path).not.toBe(afterMove.locator.path); expect(afterMove.id).toBe(beforeMove.id); expect(project.id).toBe(recordId(10)); expect(task.id).toBe(recordId(11));
  });
  it('allows the same external artifact to be referenced by multiple projects', () => {
    const sharedNote = defineExternalArtifactReference({ id: artifactId(20), kind: 'note', locator: { kind: 'vault-relative-path', path: 'Shared/One note.md' } });
    const first = defineProjectArtifactAssociations({ projectId: recordId(20), bindings: [{ role: 'artifact', artifactId: sharedNote.id }] });
    const second = defineProjectArtifactAssociations({ projectId: recordId(21), bindings: [{ role: 'artifact', artifactId: sharedNote.id }] });
    expect(resolveProjectArtifacts(first, [sharedNote])[0]?.artifact.id).toBe(sharedNote.id); expect(resolveProjectArtifacts(second, [sharedNote])[0]?.artifact.id).toBe(sharedNote.id); expect(first.projectId).not.toBe(second.projectId);
  });
  it('does not require an artifact path to live under a project directory', () => {
    const project = defineCanonicalRecordHeader({ kind: 'project', id: recordId(30), name: 'Project Alpha' });
    const attachment = defineExternalArtifactReference({ id: artifactId(30), kind: 'attachment', locator: { kind: 'vault-relative-path', path: 'Global Assets/shared.pdf' } });
    const association = defineProjectArtifactAssociations({ projectId: project.id, bindings: [{ role: 'artifact', artifactId: attachment.id }] });
    expect(resolveProjectArtifacts(association, [attachment])[0]?.artifact.locator.path).toBe('Global Assets/shared.pdf'); expect(association).not.toHaveProperty('projectDirectory'); expect(association).not.toHaveProperty('rootPath');
  });
  it('keeps external-artifact identity distinct from Proxima record identity', () => {
    const projectId = recordId(40); const externalId = artifactId(40); expect(projectId).toMatch(/^pxr_/); expect(externalId).toMatch(/^pxa_/); expect(() => parseOpaqueRecordId(externalId)).toThrow(/Invalid opaque Proxima record id/); expect(() => parseOpaqueExternalArtifactId(projectId)).toThrow(/Invalid opaque Proxima external-artifact id/);
  });
  it('resolves associations by artifact id rather than path equality', () => {
    const externalId = artifactId(50); const moved = defineExternalArtifactReference({ id: externalId, kind: 'drawing', locator: { kind: 'machine-path', path: 'D:/External drawings/moved.canvas' } }); const association = defineProjectArtifactAssociations({ projectId: recordId(50), bindings: [{ role: 'artifact', artifactId: externalId }] }); const resolved = resolveProjectArtifacts(association, [moved]); expect(resolved[0]?.artifact.id).toBe(externalId); expect(resolved[0]?.artifact.locator.path).toBe('D:/External drawings/moved.canvas'); expect(association.bindings[0]).not.toHaveProperty('path');
  });
});
