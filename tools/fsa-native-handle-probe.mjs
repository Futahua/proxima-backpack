/**
 * Browser-native directory-handle acceptance, without a user picker.
 *
 * Gate 4.4's open box says the OPFS evidence "uses the structural subset of a directory/file handle
 * and does not claim native browser permission or persistence behaviour". This tool closes that gap by
 * running the *shipped* adapter against a **native** `FileSystemDirectoryHandle` in a real browser:
 * `navigator.storage.getDirectory()` returns one without any picker, any gesture, or any grant.
 *
 * What it establishes, none of which a structural double can:
 *
 *   - the handle is a real `FileSystemDirectoryHandle` (`instanceof`, `constructor.name`), not a double;
 *   - it carries the native permission surface (`queryPermission`), and its answer is recorded;
 *   - the native-only methods exist (`isSameEntry`, `resolve`), which the structural subset cannot have;
 *   - the adapter's repository contract holds over real browser storage, including the traversal and
 *     bounded-read refusals;
 *   - anything written survives a **page load**, read back through a second, freshly obtained handle.
 *
 * It is deliberately not a substitute for the picker path: `showDirectoryPicker` is wrapped and counted
 * so the report can state that the run never called it, rather than leaving that to be assumed.
 *
 * Disposable by construction: a temporary Chrome profile under the OS temp directory holds the OPFS
 * store, so nothing in the creator's vault, the real Papers profile, or the repository is touched.
 *
 * Usage:
 *   node tools/fsa-native-handle-probe.mjs [--port 4173] [--cdp-port 9333] [--evidence <file>] [--keep]
 *
 * Exit code: 0 PASS, 1 BLOCKED, 2 usage.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_ENTRY = join(ROOT, 'public', 'build', 'adapters', 'opfsVault.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = Number(arg('port', '4173'));
const CDP_PORT = Number(arg('cdp-port', '9333'));
const EVIDENCE = arg('evidence');
const KEEP = flag('keep');

const CHROME_CANDIDATES = [
  process.env.PROXIMA_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** In-page: native facts, a fixture written with the native API, then the adapter's contract. */
const PROBE_SCRIPT = `(async () => {
  const stages = [];
  const record = (name, ok, detail) => stages.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });

  // Counted rather than assumed: if anything in this run reaches for the picker, the report says so.
  let pickerCalls = 0;
  const nativePicker = window.showDirectoryPicker;
  if (typeof nativePicker === 'function') {
    window.showDirectoryPicker = function (...args) { pickerCalls += 1; return nativePicker.apply(this, args); };
  }

  const root = await navigator.storage.getDirectory();
  const native = {
    kind: root.kind,
    name: root.name,
    constructorName: root.constructor ? root.constructor.name : null,
    instanceOfFileSystemDirectoryHandle: typeof FileSystemDirectoryHandle === 'function' && root instanceof FileSystemDirectoryHandle,
    hasGetFileHandle: typeof root.getFileHandle === 'function',
    hasQueryPermission: typeof root.queryPermission === 'function',
    hasIsSameEntry: typeof root.isSameEntry === 'function',
    hasResolve: typeof root.resolve === 'function',
    permission: typeof root.queryPermission === 'function' ? await root.queryPermission({ mode: 'read' }) : 'unknown',
    secureContext: window.isSecureContext === true,
  };
  record('native-handle', native.kind === 'directory' && native.instanceOfFileSystemDirectoryHandle === true && native.hasGetFileHandle === true, JSON.stringify(native));

  const namespace = await root.getDirectoryHandle('proxima-native-handle-probe', { create: true });
  native.namespaceName = namespace.name;
  native.isSameEntryWorks = typeof root.isSameEntry === 'function' ? await root.isSameEntry(namespace) === false : null;
  // Recorded raw rather than asserted: this is Chrome's answer for an OPFS descendant, and the point\n  // of the field is that the native surface exists and answers, not that this run predicted the answer.\n  native.resolveAnswer = typeof root.resolve === 'function' ? String(await root.resolve(namespace)) : null;

  const writeText = async (directory, name, text) => {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  };
  const vaultRoot = await namespace.getDirectoryHandle('Proxima', { create: true });
  const records = await vaultRoot.getDirectoryHandle('records', { create: true });
  const tasks = await records.getDirectoryHandle('tasks', { create: true });
  const events = await records.getDirectoryHandle('events', { create: true });
  await writeText(tasks, 'alpha.md', '{"id":"alpha","name":"Alpha","revision":1}');
  await writeText(tasks, 'beta.md', '{"id":"beta","name":"Beta","revision":1}');
  await writeText(events, 'kickoff.md', '{"id":"kickoff","name":"Kickoff","revision":1}');
  record('native-write', (await tasks.getFileHandle('alpha.md')).kind === 'file', 'fixture written through the native API');

  const adapter = await import('/build/adapters/opfsVault.js');
  const vault = adapter.createOpfsVault(namespace);
  const list = await vault.list('Proxima/records/tasks');
  const walk = await vault.walk('Proxima');
  const exists = {
    file: await vault.exists('Proxima/records/tasks/alpha.md'),
    directory: await vault.exists('Proxima/records'),
    missing: await vault.exists('Proxima/records/tasks/nope.md'),
  };
  const read = await vault.read('Proxima/records/tasks/alpha.md', 4096);

  const refusals = {};
  try { await vault.read('../escape.md', 10); refusals.traversal = null; }
  catch (error) { refusals.traversal = String(error && error.message); }
  try { await vault.read('Proxima/records/tasks/alpha.md', 3); refusals.bounded = null; }
  catch (error) { refusals.bounded = String(error && error.message); }
  try { await vault.read('Proxima/records/tasks/nope.md', 100); refusals.missing = null; }
  catch (error) { refusals.missing = String(error && error.message); }

  const contract = {
    list: list.map((entry) => entry.path),
    walk,
    exists,
    read: { path: read.path, size: read.size, text: read.text, revision: read.revision },
    refusals,
  };
  const revisionIsShaped = /^.+:\\d+:[0-9a-f]{8}$/.test(read.revision);
  // Each refusal must be the *intended* one, by message, not merely "something threw". A first version
  // of this assertion accepted any error, and a probe that removed the traversal guard survived it -
  // because a name-based handle refuses '..' anyway, by failing to find a child of that name. So the
  // guard is a refusal-quality guard for this source rather than its security boundary - the handle is
  // the boundary - and an acceptance that cannot tell those apart is worth less than one that can.
  const refusalNames = (value, expected) => typeof value === 'string' && value.includes(expected);
  record(
    'contract',
    contract.list.length === 2
      && walk.length === 3
      && exists.file === true && exists.directory === true && exists.missing === false
      && read.text.includes('"alpha"') && revisionIsShaped
      && refusalNames(contract.refusals.traversal, 'path traversal is not allowed')
      && refusalNames(contract.refusals.bounded, 'text size limit exceeded')
      && refusalNames(contract.refusals.missing, 'not found'),
    JSON.stringify(contract),
  );
  record('no-picker', pickerCalls === 0, 'showDirectoryPicker calls: ' + pickerCalls);

  return { stages, native, contract, pickerCalls };
})()`;

/** In-page, second load: a freshly obtained handle over the same profile must still see the fixture. */
const PERSISTENCE_SCRIPT = `(async () => {
  const root = await navigator.storage.getDirectory();
  const namespace = await root.getDirectoryHandle('proxima-native-handle-probe');
  const adapter = await import('/build/adapters/opfsVault.js');
  const vault = adapter.createOpfsVault(namespace);
  const walk = await vault.walk('Proxima');
  const read = await vault.read('Proxima/records/tasks/alpha.md', 4096);
  return {
    handleName: namespace.name,
    freshHandleIsNative: typeof FileSystemDirectoryHandle === 'function' && namespace instanceof FileSystemDirectoryHandle,
    walk,
    text: read.text,
    revision: read.revision,
  };
})()`;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }
}

async function waitForHttp(url, timeoutMs, { asJson = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      // A viewer answers with HTML and a DevTools endpoint with JSON: only the caller knows which it
      // wants, and demanding JSON of both is how a perfectly healthy page reads as "not up yet".
      if (response.ok) return asJson ? await response.json() : await response.text();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`nothing answered at ${url} within ${timeoutMs}ms (${lastError})`);
}

/** Run an in-page expression, retrying while the document is not yet able to answer. */
async function evaluate(cdp, sessionId, expression, { attempts = 30 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      }, sessionId);
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation threw';
        last = new Error(text.split('\n')[0]);
      } else {
        return result.result.value;
      }
    } catch (error) {
      last = error;
    }
    await sleep(400);
  }
  throw last ?? new Error('evaluation never succeeded');
}

async function main() {
  if (Number.isNaN(PORT) || Number.isNaN(CDP_PORT)) {
    console.error('usage: node tools/fsa-native-handle-probe.mjs [--port 4173] [--cdp-port 9333] [--evidence <file>] [--keep]');
    process.exit(2);
  }

  const stages = [];
  const record = (name, ok, detail) => {
    stages.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });
    console.log(`${ok ? 'PASS' : 'BLOCKED'}  ${name}  ${String(detail).slice(0, 220)}`);
  };

  if (!existsSync(BUILD_ENTRY)) {
    record('build-present', false, `missing ${BUILD_ENTRY} - run npm run build first`);
    return finish(stages, null);
  }
  record('build-present', true, BUILD_ENTRY.replace(ROOT, '.'));

  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) {
    record('browser-present', false, `no Chrome or Edge found at any of: ${CHROME_CANDIDATES.join(', ')}`);
    return finish(stages, null);
  }
  record('browser-present', true, chrome);

  const profile = await mkdtemp(join(tmpdir(), 'proxima-native-handle-'));
  // A port is chosen rather than assumed: a stale viewer from an earlier run would otherwise make this
  // tool fail in a way that looks like the product's fault. Its output is kept so a failure to bind is
  // reported instead of swallowed.
  const viewerPort = PORT === 4173 ? 4300 + Math.floor(Math.random() * 500) : PORT;
  const serverOutput = [];
  const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve-public.mjs'), '--port', String(viewerPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  let socket = null;
  try {
    const origin = `http://127.0.0.1:${viewerPort}/`;
    try {
      await waitForHttp(origin, 15_000);
    } catch (error) {
      record('static-viewer', false, `${error.message}; server said: ${serverOutput.join('').trim() || '(nothing)'}`);
      return finish(stages, null);
    }
    record('static-viewer', true, origin);

    const version = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000, { asJson: true });
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    cdp = new Cdp(socket);
    record('devtools-protocol', true, version.Browser ?? 'connected');

    const { targetId } = await cdp.send('Target.createTarget', { url: origin });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(750);

    const first = await evaluate(cdp, sessionId, PROBE_SCRIPT);
    for (const stage of first.stages) record(`in-page:${stage.name}`, stage.ok, stage.detail);

    // A second, freshly obtained handle in a second page load: the cheap proof that the bytes are in
    // real browser storage and not in the first document's memory.
    const second = await cdp.send('Target.createTarget', { url: origin });
    const attached = await cdp.send('Target.attachToTarget', { targetId: second.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, attached.sessionId);
    await sleep(750);
    const after = await evaluate(cdp, attached.sessionId, PERSISTENCE_SCRIPT);
    record(
      'survives-a-page-load',
      after.walk.length === 3 && after.text.includes('"alpha"') && after.freshHandleIsNative === true,
      `fresh handle saw ${after.walk.length} files: ${after.walk.join(', ')}`,
    );

    return finish(stages, { native: first.native, contract: first.contract, after });
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* already gone */ }
    try { socket?.close(); } catch { /* already closed */ }
    browser.kill();
    server.kill();
    // Chrome's crash handler is a child that outlives the launcher and keeps a lock inside the profile,
    // so the directory survives a plain kill. It is killed by *PID*, never by image name: this browser
    // is this tool's own child, and the creator's own Chrome is not - a name-based kill would be a way
    // to close somebody else's browser.
    if (process.platform === 'win32' && typeof browser.pid === 'number') {
      try { spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    await sleep(300);
    // Chrome's crash handler holds the profile for a moment after the browser exits, so a single
    // removal attempt leaves the directory behind - seventeen of them, measured before this loop
    // existed. Retried, and reported rather than swallowed if it still will not go.
    if (!KEEP) {
      let removed = false;
      for (let attempt = 0; attempt < 8 && !removed; attempt += 1) {
        try {
          await rm(profile, { recursive: true, force: true });
          removed = true;
        } catch {
          await sleep(400);
        }
      }
      if (!removed) console.log(`note: the disposable profile could not be removed yet: ${profile}`);
    }
  }
}

async function finish(stages, evidence) {
  const blocked = stages.filter((stage) => !stage.ok);
  const report = {
    schemaVersion: 1,
    tool: 'fsa-native-handle-probe',
    ranAt: new Date().toISOString(),
    verdict: blocked.length === 0 ? 'PASS' : 'BLOCKED',
    stages,
    ...(evidence ? { evidence } : {}),
  };
  if (EVIDENCE) {
    await mkdir(dirname(resolve(EVIDENCE)), { recursive: true });
    await writeFile(resolve(EVIDENCE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`evidence: ${resolve(EVIDENCE)}`);
  }
  console.log(`\n${report.verdict}: ${stages.length - blocked.length}/${stages.length} stages passed`);
  if (blocked.length > 0) for (const stage of blocked) console.log(`  blocked: ${stage.name} - ${stage.detail}`);
  // The exit code is *set*, not exited. This function is called from inside a `return` expression, and
  // `process.exit` there ended the process before the caller's `finally` could tear the browser and the
  // disposable profile down - which is how seventeen of those profiles accumulated before anyone counted.
  process.exitCode = blocked.length === 0 ? 0 : 1;
  return report;
}

await main();
