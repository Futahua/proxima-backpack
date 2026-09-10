import { validateVaultRelativePath, vaultFileExtension, vaultFileName } from '../domain/canvas.js';
import { recogniseExcalidraw } from '../domain/excalidraw.js';
import { renderExcalidrawSvg } from '../domain/excalidrawRender.js';
import type { Project } from '../domain/types.js';
import type { VaultFile, VaultReader } from '../ports/vault.js';

export const MAX_PROJECT_NOTE_TREE_FILES = 2_000;
export const MAX_PROJECT_NOTE_PREVIEW_CHARS = 200_000;
export const MAX_PROJECT_CANVAS_PREVIEW_NODES = 64;

export type ProjectNoteTreeRootStatus = 'ready' | 'missing' | 'unavailable';

export interface ProjectNoteTreeEntry {
  rootPath: string;
  path: string;
  parentPath: string;
  name: string;
  kind: 'directory' | 'file';
  depth: number;
}

export interface ProjectNoteTreeRoot {
  name: string;
  path: string;
  status: ProjectNoteTreeRootStatus;
  entries: ProjectNoteTreeEntry[];
  fileCount: number;
  truncated: boolean;
}

export interface ProjectNotesTreeSnapshot {
  projectId: string;
  roots: ProjectNoteTreeRoot[];
  fileCount: number;
}

interface ProjectNotePreviewBase {
  path: string;
  revision: string;
  size: number;
  modifiedAt: string;
}

export interface ProjectCanvasNodeSummary {
  id: string;
  type: string;
  label: string;
}

export type ProjectNotePreview =
  | (ProjectNotePreviewBase & { kind: 'markdown'; text: string; })
  | (ProjectNotePreviewBase & { kind: 'canvas'; nodeCount: number; edgeCount: number; nodes: ProjectCanvasNodeSummary[]; truncated: boolean; })
  | (ProjectNotePreviewBase & { kind: 'excalidraw'; svg: string; sceneElements: number; renderedElements: number; problemCount: number; });

export type ProjectNotePreviewFailure = 'invalid-path' | 'unreadable' | 'preview-too-large' | 'unsupported-format' | 'canvas-invalid' | 'excalidraw-unavailable';
export interface ProjectNotePreviewResult { preview: ProjectNotePreview | null; failure: ProjectNotePreviewFailure | null; }

function unavailableRoot(name: string, path: string): ProjectNoteTreeRoot { return { name, path, status: 'unavailable', entries: [], fileCount: 0, truncated: false }; }
function missingRoot(name: string, path: string): ProjectNoteTreeRoot { return { name, path, status: 'missing', entries: [], fileCount: 0, truncated: false }; }
function entryOrder(left: ProjectNoteTreeEntry, right: ProjectNoteTreeEntry): number { return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind); }

async function loadRoot(vault: VaultReader, name: string, path: string): Promise<ProjectNoteTreeRoot> {
  let rootPath: string;
  try { rootPath = validateVaultRelativePath(path); } catch { return unavailableRoot(name, path); }
  try { if (!(await vault.exists(rootPath))) return missingRoot(name, rootPath); } catch { return unavailableRoot(name, rootPath); }
  let walked: string[];
  try { walked = await vault.walk(rootPath); } catch { return unavailableRoot(name, rootPath); }
  const prefix = `${rootPath}/`;
  const files = new Set<string>();
  for (const candidate of walked) {
    let safe: string;
    try { safe = validateVaultRelativePath(candidate); } catch { return unavailableRoot(name, rootPath); }
    if (!safe.startsWith(prefix)) return unavailableRoot(name, rootPath);
    files.add(safe);
  }
  const orderedFiles = [...files].sort();
  const visibleFiles = orderedFiles.slice(0, MAX_PROJECT_NOTE_TREE_FILES);
  const entries = new Map<string, ProjectNoteTreeEntry>();
  for (const filePath of visibleFiles) {
    const relative = filePath.slice(prefix.length);
    const parts = relative.split('/');
    for (let index = 0; index < parts.length - 1; index += 1) {
      const directoryPath = `${rootPath}/${parts.slice(0, index + 1).join('/')}`;
      if (!entries.has(directoryPath)) entries.set(directoryPath, { rootPath, path: directoryPath, parentPath: index === 0 ? rootPath : `${rootPath}/${parts.slice(0, index).join('/')}`, name: parts[index]!, kind: 'directory', depth: index + 1 });
    }
    entries.set(filePath, { rootPath, path: filePath, parentPath: parts.length === 1 ? rootPath : `${rootPath}/${parts.slice(0, -1).join('/')}`, name: parts.at(-1) ?? vaultFileName(filePath), kind: 'file', depth: parts.length });
  }
  return { name, path: rootPath, status: 'ready', entries: [...entries.values()].sort(entryOrder), fileCount: orderedFiles.length, truncated: orderedFiles.length > MAX_PROJECT_NOTE_TREE_FILES };
}

export async function loadProjectNotesTree(vault: VaultReader, project: Project): Promise<ProjectNotesTreeSnapshot> {
  const roots = await Promise.all(project.linkedFolders.map((folder) => loadRoot(vault, folder.name, folder.path)));
  return { projectId: project.id, roots, fileCount: roots.reduce((total, root) => total + root.fileCount, 0) };
}

function previewBase(file: VaultFile): ProjectNotePreviewBase { return { path: file.path, revision: file.revision, size: file.size, modifiedAt: file.modifiedAt }; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function boundedString(value: unknown, fallback: string, limit: number): string { return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : fallback; }
function canvasNodeSummary(value: unknown, index: number): ProjectCanvasNodeSummary { const node = record(value); const type = boundedString(node?.type, 'unknown', 40); const id = boundedString(node?.id, `node-${index + 1}`, 120); const labelSource = node?.text ?? node?.file ?? node?.url ?? node?.label; return { id, type, label: boundedString(labelSource, type, 240) }; }
function canvasPreview(file: VaultFile): ProjectNotePreviewResult {
  let parsed: unknown;
  try { parsed = JSON.parse(file.text); } catch { return { preview: null, failure: 'canvas-invalid' }; }
  const canvas = record(parsed);
  if (!canvas || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) return { preview: null, failure: 'canvas-invalid' };
  return { preview: { ...previewBase(file), kind: 'canvas', nodeCount: canvas.nodes.length, edgeCount: canvas.edges.length, nodes: canvas.nodes.slice(0, MAX_PROJECT_CANVAS_PREVIEW_NODES).map(canvasNodeSummary), truncated: canvas.nodes.length > MAX_PROJECT_CANVAS_PREVIEW_NODES }, failure: null };
}

export async function loadProjectNotePreview(vault: VaultReader, path: string): Promise<ProjectNotePreviewResult> {
  let safePath: string;
  try { safePath = validateVaultRelativePath(path); } catch { return { preview: null, failure: 'invalid-path' }; }
  let file: VaultFile;
  try { file = await vault.read(safePath, MAX_PROJECT_NOTE_PREVIEW_CHARS); } catch { return { preview: null, failure: 'unreadable' }; }
  if (file.path !== safePath) return { preview: null, failure: 'unreadable' };
  if (file.text.length > MAX_PROJECT_NOTE_PREVIEW_CHARS) return { preview: null, failure: 'preview-too-large' };
  const excalidraw = recogniseExcalidraw(file.text, safePath);
  if (excalidraw.kind !== 'not-excalidraw') {
    if (excalidraw.scene === null) return { preview: null, failure: 'excalidraw-unavailable' };
    const rendered = renderExcalidrawSvg(excalidraw.scene);
    return { preview: { ...previewBase(file), kind: 'excalidraw', svg: rendered.svg, sceneElements: rendered.census.sceneElements, renderedElements: rendered.census.rendered, problemCount: excalidraw.problems.length + rendered.problems.reduce((total, problem) => total + problem.count, 0) }, failure: null };
  }
  const extension = vaultFileExtension(safePath);
  if (extension === 'canvas') return canvasPreview(file);
  if (extension === 'md' || extension === 'markdown') return { preview: { ...previewBase(file), kind: 'markdown', text: file.text }, failure: null };
  return { preview: null, failure: 'unsupported-format' };
}
