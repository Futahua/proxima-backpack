import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback = '') => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
const rootArg = value('--root');
const port = Number(value('--port', '4174'));
if (!rootArg) throw new Error('Usage: node tools/agent-vault-bridge.mjs --root <creator-vault> [--port 4174]');
const root = resolve(rootArg);
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 64;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function relativePath(input) {
  const path = String(input ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw new Error('invalid relative path');
  return path;
}
function absolute(input) {
  const path = String(input ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (path && (path.split('/').some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path))) throw new Error('invalid relative path');
  const target = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error('path escapes configured root');
  return target;
}
function revision(text, metadata) { return `${metadata.mtime.toISOString()}:${metadata.size}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`; }
async function list(path) { const directory = absolute(path); const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); if (entries.length > MAX_ENTRIES) throw new Error('entry bound exceeded'); return entries.map((entry) => { if (entry.isSymbolicLink()) throw new Error('symbolic links are not supported'); return { path: path ? `${path}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }; }); }
async function walk(path, depth = 0, budget = { count: 0 }) { if (depth > MAX_DEPTH) throw new Error('depth bound exceeded'); const entries = await list(path); const files = []; for (const entry of entries) { budget.count += 1; if (budget.count > MAX_ENTRIES) throw new Error('entry bound exceeded'); if (entry.kind === 'file') files.push(entry.path); else files.push(...await walk(entry.path, depth + 1, budget)); } return files.sort(); }
function send(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' }); response.end(JSON.stringify(body)); }
const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  if (request.method !== 'GET') return send(response, 405, { error: 'read-only bridge' });
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') return send(response, 200, { ok: true, readOnly: true, bounds: { maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH, maxFileBytes: MAX_FILE_BYTES } });
    if (!url.pathname.startsWith('/api/vault/')) return send(response, 404, { error: 'not found' });
    const operation = url.pathname.slice('/api/vault/'.length);
    const path = url.searchParams.get('path') ?? '';
    if (operation === 'list') return send(response, 200, { entries: await list(path) });
    if (operation === 'walk') return send(response, 200, { files: await walk(path) });
    if (operation === 'exists') { try { const target = absolute(path); const metadata = await lstat(target); return send(response, 200, { exists: !metadata.isSymbolicLink() }); } catch { return send(response, 200, { exists: false }); } }
    if (operation === 'read') { const target = absolute(path); const linkMetadata = await lstat(target); if (linkMetadata.isSymbolicLink()) throw new Error('symbolic links are not supported'); const metadata = await stat(target); if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error('file bound exceeded'); const text = await readFile(target, 'utf8'); if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('file bound exceeded'); return send(response, 200, { path: relative(root, target).split(sep).join('/'), text, size: metadata.size, modifiedAt: metadata.mtime.toISOString(), revision: revision(text, metadata) }); }
    return send(response, 404, { error: 'unknown operation' });
  } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message.slice(0, 160) : 'bridge failure' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Proxima read-only automation bridge listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
