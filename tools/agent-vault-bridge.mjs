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

/**
 * Every failure leaves this process as one of these codes and nothing else.
 *
 * A raw filesystem error carries the absolute path it failed on — `ENOENT: no such
 * file or directory, scandir 'D:\...\Vault\Missing'` — so forwarding `error.message`
 * publishes the creator's vault location to every caller and into any evidence
 * bundle that records a bridge response. The bound is not the length of the string;
 * it is that the string is drawn from this list.
 */
const BRIDGE_CODES = Object.freeze({
  invalidPath: 'invalid-path',
  escapesRoot: 'path-escapes-root',
  symlink: 'symlink-rejected',
  entryBound: 'entry-bound-exceeded',
  depthBound: 'depth-bound-exceeded',
  fileBound: 'file-bound-exceeded',
  notFound: 'not-found',
  notADirectory: 'not-a-directory',
  notPermitted: 'not-permitted',
  unavailable: 'source-unavailable',
  unknownOperation: 'unknown-operation',
  notFoundRoute: 'not-found-route',
  readOnly: 'read-only-bridge',
  hostNotAllowed: 'host-not-allowed',
});

/** Node errno -> bounded code. Anything unrecognised degrades to source-unavailable. */
const ERRNO_CODES = Object.freeze({
  ENOENT: BRIDGE_CODES.notFound,
  ENOTDIR: BRIDGE_CODES.notADirectory,
  EISDIR: BRIDGE_CODES.notADirectory,
  EACCES: BRIDGE_CODES.notPermitted,
  EPERM: BRIDGE_CODES.notPermitted,
  ELOOP: BRIDGE_CODES.symlink,
  ENAMETOOLONG: BRIDGE_CODES.invalidPath,
});

class BridgeError extends Error {
  constructor(code) { super(code); this.bridgeCode = code; }
}

function codeOf(error) {
  if (error instanceof BridgeError) return error.bridgeCode;
  const errno = error && typeof error === 'object' ? error.code : undefined;
  return ERRNO_CODES[errno] ?? BRIDGE_CODES.unavailable;
}

function relativePath(input) {
  const path = String(input ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw new BridgeError(BRIDGE_CODES.invalidPath);
  return path;
}
function absolute(input) {
  const path = String(input ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (path && (path.split('/').some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path))) throw new BridgeError(BRIDGE_CODES.invalidPath);
  const target = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new BridgeError(BRIDGE_CODES.escapesRoot);
  return target;
}
function revision(text, metadata) { return `${metadata.mtime.toISOString()}:${metadata.size}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`; }
/**
 * List a directory, omitting symlinks rather than refusing the whole listing.
 *
 * Rejecting the directory was the wrong granularity: a creator's project folder
 * legitimately contains a linked-folder symlink beside its index.md — that link is
 * Proxima's own feature — and one dangling link erased all 31 project folders from
 * a real vault. Skipping keeps the traversal no more permissive, since nothing is
 * ever read through a link, while letting the ordinary files beside it survive.
 *
 * The count travels with the answer so the omission is visible rather than silent.
 * Target paths never do.
 */
async function list(path) {
  const directory = absolute(path);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > MAX_ENTRIES) throw new BridgeError(BRIDGE_CODES.entryBound);
  let skippedSymlinks = 0;
  const kept = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue; }
    kept.push({ path: path ? `${path}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
  }
  return { entries: kept, skippedSymlinks };
}
/** Recurse ordinary directories only, aggregating what was skipped on the way. */
async function walk(path, depth = 0, budget = { count: 0, skippedSymlinks: 0 }) {
  if (depth > MAX_DEPTH) throw new BridgeError(BRIDGE_CODES.depthBound);
  const listing = await list(path);
  budget.skippedSymlinks += listing.skippedSymlinks;
  const files = [];
  for (const entry of listing.entries) {
    budget.count += 1;
    if (budget.count > MAX_ENTRIES) throw new BridgeError(BRIDGE_CODES.entryBound);
    if (entry.kind === 'file') files.push(entry.path);
    else files.push(...(await walk(entry.path, depth + 1, budget)).files);
  }
  return { files: files.sort(), skippedSymlinks: budget.skippedSymlinks };
}

/**
 * Reflect only a loopback page's own origin.
 *
 * Pinning a single dev-server port meant the header was wrong the moment the bridge
 * ran anywhere else, while still being no stricter: a browser only honours it as an
 * exact match. Reflecting loopback origins keeps that exactness without guessing a
 * port. A page served from anywhere else gets no header at all, so it cannot read a
 * response even if it reaches the socket.
 */
function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return isLoopbackHost(url.hostname) ? origin : null;
  } catch { return null; }
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Refuse a request whose Host header is not loopback.
 *
 * The socket is bound to 127.0.0.1, which stops remote packets but not a public
 * name that resolves there: DNS rebinding lets a page keep its own origin while the
 * request lands on this port. Checking Host rejects that at the door rather than
 * relying on the CORS header alone.
 */
function hostAllowed(request) {
  const host = String(request.headers.host ?? '');
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return isLoopbackHost(name);
}

function send(response, status, body, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Origin', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };
  if (origin) headers['access-control-allow-origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const origin = allowedOrigin(request);
  if (!hostAllowed(request)) return send(response, 403, { error: BRIDGE_CODES.hostNotAllowed }, origin);
  if (request.method === 'OPTIONS') return send(response, 204, {}, origin);
  if (request.method !== 'GET') return send(response, 405, { error: BRIDGE_CODES.readOnly }, origin);
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') return send(response, 200, { ok: true, readOnly: true, bounds: { maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH, maxFileBytes: MAX_FILE_BYTES } }, origin);
    if (!url.pathname.startsWith('/api/vault/')) return send(response, 404, { error: BRIDGE_CODES.notFoundRoute }, origin);
    const operation = url.pathname.slice('/api/vault/'.length);
    const path = url.searchParams.get('path') ?? '';
    if (operation === 'list') return send(response, 200, await list(path), origin);
    if (operation === 'walk') return send(response, 200, await walk(path), origin);
    if (operation === 'read-binary') {
      // The same file `read` serves, returned unmangled. No new authority: the same
      // containment, the same symlink refusal, the same bounds. Base64 only because
      // this is an HTTP boundary; the domain contract is bytes.
      const target = absolute(path);
      const linkMetadata = await lstat(target);
      if (linkMetadata.isSymbolicLink()) throw new BridgeError(BRIDGE_CODES.symlink);
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new BridgeError(BRIDGE_CODES.notADirectory);
      const requested = Number(url.searchParams.get('maxBytes') ?? MAX_FILE_BYTES);
      const ceiling = Math.min(Number.isFinite(requested) && requested > 0 ? requested : MAX_FILE_BYTES, MAX_FILE_BYTES);
      if (metadata.size > ceiling) throw new BridgeError(BRIDGE_CODES.fileBound);
      const buffer = await readFile(target);
      return send(response, 200, {
        path: relativePath(relative(root, target).split(sep).join('/')),
        base64: buffer.toString('base64'),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        revision: revision(buffer.toString('binary'), metadata),
      }, origin);
    }
    if (operation === 'presence') {
      // Absence must be provable, not inferred from a failed listing. ENOENT and
      // ENOTDIR say the directory is genuinely not there; a permission or I/O
      // failure says it is there and unreadable, which is a different fact; and
      // anything unrecognised stays 'unknown' so the caller fails closed.
      try {
        const target = absolute(path);
        await lstat(target);
        return send(response, 200, { presence: 'present' }, origin);
      } catch (error) {
        const errno = error && typeof error === 'object' ? error.code : undefined;
        if (error instanceof BridgeError) return send(response, 200, { presence: 'unknown' }, origin);
        if (errno === 'ENOENT' || errno === 'ENOTDIR') return send(response, 200, { presence: 'missing' }, origin);
        if (errno === 'EACCES' || errno === 'EPERM') return send(response, 200, { presence: 'present' }, origin);
        return send(response, 200, { presence: 'unknown' }, origin);
      }
    }
    if (operation === 'exists') { try { const target = absolute(path); const metadata = await lstat(target); return send(response, 200, { exists: !metadata.isSymbolicLink() }, origin); } catch { return send(response, 200, { exists: false }, origin); } }
    if (operation === 'read') { const target = absolute(path); const linkMetadata = await lstat(target); if (linkMetadata.isSymbolicLink()) throw new BridgeError(BRIDGE_CODES.symlink); const metadata = await stat(target); if (!metadata.isFile()) throw new BridgeError(BRIDGE_CODES.notADirectory); if (metadata.size > MAX_FILE_BYTES) throw new BridgeError(BRIDGE_CODES.fileBound); const text = await readFile(target, 'utf8'); if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new BridgeError(BRIDGE_CODES.fileBound); return send(response, 200, { path: relativePath(relative(root, target).split(sep).join('/')), text, size: metadata.size, modifiedAt: metadata.mtime.toISOString(), revision: revision(text, metadata) }, origin); }
    return send(response, 404, { error: BRIDGE_CODES.unknownOperation }, origin);
  } catch (error) { return send(response, 400, { error: codeOf(error) }, origin); }
});
// Report the port actually bound, not the one requested: --port 0 asks the OS to
// choose, and echoing the request back left an ephemeral bridge unaddressable.
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  console.log(`Proxima read-only automation bridge listening on 127.0.0.1:${bound}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
