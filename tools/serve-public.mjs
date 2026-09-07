import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A loopback static server for `public/`, so the built page can be looked at.
 *
 * The Papers host serves this build through its own `papers-backpack://` scheme;
 * this exists only so a person or an agent can open the same bytes in an ordinary
 * browser while that host is not in the picture. It is a viewer, not a product
 * surface: loopback-bound, GET only, and confined to `public/`.
 */

const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 4173);

const server = createServer(async (request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end('read-only viewer');
    return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = resolve(join(ROOT, normalize(decodeURIComponent(requested))));
    // Serve nothing outside public/, whatever the path claims.
    if (target !== ROOT && !target.startsWith(ROOT.endsWith(sep) ? ROOT : `${ROOT}${sep}`)) {
      response.writeHead(403).end('outside the served root');
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  console.log(`Proxima static viewer listening on http://127.0.0.1:${bound}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
