import {
  parseOpaqueRecordId,
  type OpaqueRecordId,
} from './canonicalIdentity.js';

const OPAQUE_EXTERNAL_ARTIFACT_ID_PATTERN = /^pxa_[0-9a-f]{32}$/;
declare const opaqueExternalArtifactIdBrand: unique symbol;

export type OpaqueExternalArtifactId = string & {
  readonly [opaqueExternalArtifactIdBrand]: 'OpaqueExternalArtifactId';
};

export function parseOpaqueExternalArtifactId(value: string): OpaqueExternalArtifactId {
  if (!OPAQUE_EXTERNAL_ARTIFACT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid opaque Proxima external-artifact id: ${value}`);
  }
  return value as OpaqueExternalArtifactId;
}

export function opaqueExternalArtifactIdFromRandomBytes(bytes: Uint8Array): OpaqueExternalArtifactId {
  if (bytes.length !== 16) {
    throw new Error('Opaque Proxima external-artifact ids need exactly 16 random bytes.');
  }
  const body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return parseOpaqueExternalArtifactId(`pxa_${body}`);
}

export type ExternalArtifactLocator =
  | { readonly kind: 'vault-relative-path'; readonly path: string }
  | { readonly kind: 'machine-path'; readonly path: string };

export type ExternalArtifactKind = 'folder' | 'note' | 'drawing' | 'attachment';

export interface ExternalArtifactReference {
  readonly id: OpaqueExternalArtifactId;
  readonly kind: ExternalArtifactKind;
  readonly locator: ExternalArtifactLocator;
}

export type ProjectArtifactRole =
  | 'notes-root'
  | 'drawings-root'
  | 'attachments-root'
  | 'artifact';

export interface ProjectArtifactBinding {
  readonly role: ProjectArtifactRole;
  readonly artifactId: OpaqueExternalArtifactId;
}

export interface CanonicalProjectArtifactAssociations {
  readonly projectId: OpaqueRecordId;
  readonly bindings: readonly ProjectArtifactBinding[];
}

export function defineExternalArtifactReference(input: {
  id: OpaqueExternalArtifactId;
  kind: ExternalArtifactKind;
  locator: ExternalArtifactLocator;
}): ExternalArtifactReference {
  const id = parseOpaqueExternalArtifactId(input.id);
  if (input.locator.path.trim() === '') {
    throw new Error('External artifact locator path must not be empty.');
  }
  return { id, kind: input.kind, locator: { kind: input.locator.kind, path: input.locator.path } };
}

export function defineProjectArtifactAssociations(input: {
  projectId: OpaqueRecordId;
  bindings: readonly ProjectArtifactBinding[];
}): CanonicalProjectArtifactAssociations {
  const projectId = parseOpaqueRecordId(input.projectId);
  const seen = new Set<string>();
  const bindings = input.bindings.map((binding) => {
    const artifactId = parseOpaqueExternalArtifactId(binding.artifactId);
    const key = `${binding.role}:${artifactId}`;
    if (seen.has(key)) throw new Error(`Duplicate project artifact binding: ${key}`);
    seen.add(key);
    return { role: binding.role, artifactId };
  });
  return { projectId, bindings };
}

export function resolveProjectArtifacts(
  association: CanonicalProjectArtifactAssociations,
  references: readonly ExternalArtifactReference[],
): Array<{ readonly role: ProjectArtifactRole; readonly artifact: ExternalArtifactReference }> {
  const byId = new Map<OpaqueExternalArtifactId, ExternalArtifactReference>(references.map((reference) => [reference.id, reference]));
  return association.bindings.map((binding) => {
    const artifact = byId.get(binding.artifactId);
    if (!artifact) throw new Error(`External artifact reference does not exist: ${binding.artifactId}`);
    return { role: binding.role, artifact };
  });
}
