export const FSA_PROBE_SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 200;
const MAX_TEXT = 400;
const DB_NAME = 'proxima-gate5-probe';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'selected-directory';
let activeHandle: DirectoryHandleLike | null = null;

type FileLike = { text(): Promise<string>; size: number; lastModified: number };
type FileHandleLike = { kind: 'file'; name: string; getFile(): Promise<FileLike> };
type DirectoryHandleLike = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, FileHandleLike | DirectoryHandleLike]>;
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike> };

export interface FsaProbeEntry {
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  textMarker?: string;
  revision?: string;
}

export interface FsaProbeReport {
  schemaVersion: typeof FSA_PROBE_SCHEMA_VERSION;
  handleName: string;
  permission: PermissionState | 'unknown';
  entries: FsaProbeEntry[];
  persisted: boolean;
}

function boundedText(text: string): string { return text.slice(0, MAX_TEXT); }

async function inspect(handle: DirectoryHandleLike): Promise<FsaProbeEntry[]> {
  const output: FsaProbeEntry[] = [];
  async function visit(directory: DirectoryHandleLike, prefix: string): Promise<void> {
    for await (const [name, child] of directory.entries()) {
      if (output.length >= MAX_ENTRIES) return;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'directory') {
        output.push({ path, kind: 'directory' });
        await visit(child, path);
      } else {
        const file = await child.getFile();
        const text = await file.text();
        const modifiedAt = new Date(file.lastModified || 0).toISOString();
        output.push({ path, kind: 'file', size: file.size, textMarker: boundedText(text), revision: `${modifiedAt}:${file.size}:${text.length}` });
      }
    }
  }
  await visit(handle, '');
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function openStore(): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME));
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function persist(handle: DirectoryHandleLike): Promise<boolean> {
  try {
    const store = await openStore();
    await new Promise<void>((resolve, reject) => { const request = store.put(handle, HANDLE_KEY); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    return true;
  } catch { return false; }
}

async function restore(): Promise<DirectoryHandleLike | null> {
  try {
    const store = await openStore();
    return await new Promise<DirectoryHandleLike | null>((resolve, reject) => { const request = store.get(HANDLE_KEY); request.onsuccess = () => resolve((request.result as DirectoryHandleLike | undefined) ?? null); request.onerror = () => reject(request.error); });
  } catch { return null; }
}

async function report(handle: DirectoryHandleLike, persisted: boolean): Promise<FsaProbeReport> {
  const permission = handle.queryPermission ? await handle.queryPermission({ mode: 'read' }).catch(() => 'unknown' as const) : 'unknown';
  return { schemaVersion: FSA_PROBE_SCHEMA_VERSION, handleName: handle.name, permission, entries: await inspect(handle), persisted };
}

export async function pickAndProbeDirectory(): Promise<FsaProbeReport> {
  const picker = (globalThis as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('showDirectoryPicker is unavailable in this surface');
  const handle = await picker({ mode: 'read' });
  activeHandle = handle;
  return report(handle, await persist(handle));
}

export async function restoreAndProbeDirectory(): Promise<FsaProbeReport | null> {
  const handle = await restore();
  activeHandle = handle;
  return handle ? report(handle, true) : null;
}

export async function rereadSelectedDirectory(): Promise<FsaProbeReport | null> {
  return activeHandle ? report(activeHandle, true) : null;
}
