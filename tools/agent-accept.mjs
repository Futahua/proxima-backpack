import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { changedPaths, fingerprint } from './tree-fingerprint.mjs';

/**
 * Gate 6P — unattended bridge-backed real-vault acceptance.
 *
 * One command, an explicitly supplied root, no picker, no gesture, nobody at the
 * screen:
 *
 *     npm run agent:accept -- --root <creator-vault-root>
 *
 * It starts the audited loopback bridge, drives the same adapter, domain, session
 * and evidence evaluators the browser uses — not a second parser — and prints one
 * bounded machine-readable result.
 *
 * What it may never do, and what the tests hold it to:
 *
 *  - **Name the root.** Not in stdout, stderr, the result, or an error. The supplied
 *    path is the one thing this program knows that nobody else should learn from it.
 *  - **Write.** The reader is wrapped in the capability witness, and the tree is
 *    fingerprinted either side. A write attempt or an unexplained delta is ABORTED,
 *    not a warning.
 *  - **Claim more than it observed.** Native FSA, clean-profile picker and real
 *    Obsidian coexistence stay OPEN even on a clean pass, and the result says
 *    `papersHosted: false` because this transport cannot run inside Papers at all.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILD = new URL('../public/build/', import.meta.url);
const BRIDGE = fileURLToPath(new URL('./agent-vault-bridge.mjs', import.meta.url));

export const ACCEPTANCE_SCHEMA_VERSION = 1;
const MAX_CODES = 20;
const STARTUP_TIMEOUT_MS = 10_000;

/** Every way this harness can end. Nothing else is ever printed. */
const CODES = Object.freeze({
  bridgeStartFailed: 'bridge-start-failed',
  bridgeUnreachable: 'bridge-unreachable',
  disclosureLeak: 'transport-disclosure-leak',
  sourceUnreadable: 'source-unreadable',
  loadFailed: 'source-load-failed',
  emptySource: 'source-empty',
  witnessUnwired: 'zero-write-witness-unwired',
  writeAttempted: 'write-attempted',
  treeMutated: 'source-tree-mutated',
  pathLeak: 'unsafe-path-in-evidence',
  buildMismatch: 'build-mismatch',
  modulesUnavailable: 'acceptance-modules-unavailable',
});

/**
 * Decide whether the tree moved for a reason the caller declared.
 *
 * Exported so the decision itself is tested rather than a test-only hook being
 * threaded through the harness. Attribution is path-specific on purpose: "some peer
 * operation happened, so ignore everything that changed" is exactly the reasoning
 * that hid a rename's source path earlier, so each declared operation must name
 * every path it touches and anything else fails.
 */
export function evaluateTreeDelta(before, after, declaredPeerWrites) {
  const declared = Array.isArray(declaredPeerWrites) ? declaredPeerWrites : [];
  const unattributed = changedPaths(before, after).filter((path) => !declared.includes(path));
  return { ok: unattributed.length === 0, unattributed };
}

export async function runAcceptance(options = {}) {
  const root = options.root ? resolve(options.root) : '';
  if (!root) throw new Error('a --root is required; this harness never discovers or guesses one');

  const blockers = [];
  const stages = {};
  let aborted = false;
  let bridge = null;
  let port = 0;

  const fail = (code, { abort = false } = {}) => {
    blockers.push(code);
    if (abort) aborted = true;
  };

  try {
    // An ephemeral port by default: nothing binds a predictable port on a machine
    // that may be running several of these.
    const started = await startBridge(root, options.port ?? 0, options.spawnBridge);
    bridge = started.child;
    port = started.port;
    stages.bridge = 'PASS';

    // Prerequisite, before a single byte of the vault is read: prove the transport
    // itself cannot disclose the root. The layer beneath this one shipped leaking it.
    const disclosure = await probeDisclosure(port, root, started.output);
    stages.disclosure = disclosure.ok ? 'PASS' : 'FAIL';
    if (!disclosure.ok) fail(CODES.disclosureLeak, { abort: true });

    const before = await fingerprint(root);

    const { witness, load } = await readThroughWitness(port, options);
    stages.baselineRead = load.ok ? 'PASS' : 'FAIL';
    if (!load.ok) fail(load.code ?? CODES.loadFailed);

    // Liveness, capability, then effect — in that order, because an unwired witness
    // would make the other two meaningless.
    try {
      witness.assertObserved();
      stages.zeroWriteWitness = 'PASS';
    } catch (error) {
      stages.zeroWriteWitness = 'FAIL';
      fail(String(error).includes('no reads') ? CODES.witnessUnwired : CODES.writeAttempted, { abort: true });
    }
    if (witness.violations.length > 0) fail(CODES.writeAttempted, { abort: true });

    const effect = evaluateTreeDelta(before, await fingerprint(root), options.declaredPeerWrites);
    stages.zeroWriteEffect = effect.ok ? 'PASS' : 'FAIL';
    if (!effect.ok) fail(CODES.treeMutated, { abort: true });

    // Evidence must not carry an absolute path even when everything passed.
    const unsafe = (load.paths ?? []).filter((path) => !safeRelative(path));
    stages.pathSafety = unsafe.length === 0 ? 'PASS' : 'FAIL';
    if (unsafe.length > 0) fail(CODES.pathLeak, { abort: true });

    if (load.ok && (load.counts?.records ?? 0) === 0) fail(CODES.emptySource);

    return result({ blockers, stages, aborted, counts: load.counts, reads: witness.reads.length });
  } catch (error) {
    fail(codeFor(error));
    return result({ blockers, stages, aborted, counts: null, reads: 0 });
  } finally {
    // Terminate only what this run started, and wait for it to actually go.
    // Exiting while the child's stdio handles are still closing trips a libuv
    // assertion on Windows, which would turn a clean acceptance run into a crash.
    if (bridge && !options.spawnBridge) await stopBridge(bridge);
  }
}

/** Kill the spawned bridge and wait for its handles to close, bounded. */
async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveP) => {
    const timer = setTimeout(resolveP, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolveP(undefined); });
    child.kill();
  });
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
}

async function startBridge(root, port, override) {
  if (override) return override(root, port);
  const child = spawn(process.execPath, [BRIDGE, '--root', root, '--port', String(port || 0)], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  const listeningPort = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(CODES.bridgeStartFailed)), STARTUP_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolveP(Number(match[1])); }
    });
    child.once('error', () => { clearTimeout(timer); rejectP(new Error(CODES.bridgeStartFailed)); });
    child.once('exit', () => { clearTimeout(timer); rejectP(new Error(CODES.bridgeStartFailed)); });
  });
  return { child, port: listeningPort, output };
}

/** Ask the transport for something that fails, and check what it says back. */
async function probeDisclosure(port, root, output) {
  const probes = ['/api/vault/list?path=__proxima_missing__', '/api/vault/read?path=' + encodeURIComponent('../escape')];
  for (const probe of probes) {
    const response = await fetch(`http://127.0.0.1:${port}${probe}`);
    const body = await response.text();
    if (body.includes(root) || /ENOENT|scandir|no such file/i.test(body)) return { ok: false };
  }
  if ((output ?? []).join('').includes(root)) return { ok: false };
  return { ok: true };
}

/**
 * Load a compiled module without going through whatever loader is hosting us.
 *
 * A plain dynamic `import()` is wrong here for two independent reasons. A Vite-based
 * test runner rewrites dynamic specifiers and resolves them against its own module
 * graph, so the harness would exercise re-transformed sources instead of the build
 * output the browser actually runs — which is the entire point of Gate 6P. And its
 * resolver does not decode a percent-encoded file URL, so the first directory with a
 * space in its name (this repository has one) fails outright.
 *
 * `require()` handles ES modules on Node 22.12+ and resolves a plain absolute path,
 * so it avoids both. The dynamic-import fallback covers any runtime where it does
 * not, and a failure here is reported as a missing build rather than a transport
 * fault.
 */
const requireBuilt = createRequire(import.meta.url);

async function loadBuiltModule(relative) {
  const path = fileURLToPath(new URL(relative, BUILD));
  try {
    return requireBuilt(path);
  } catch {
    return import(/* @vite-ignore */ new URL(relative, BUILD).href);
  }
}

async function readThroughWitness(port, options) {
  let modules;
  try {
    modules = await Promise.all([
      loadBuiltModule('adapters/httpDirectory.js'),
      loadBuiltModule('adapters/externalDirectoryVault.js'),
      loadBuiltModule('app/zeroWriteWitness.js'),
      loadBuiltModule('app/vaultRepository.js'),
    ]);
  } catch {
    // Never report a missing build as a transport failure; run `npm run build`.
    throw new Error(CODES.modulesUnavailable);
  }
  const [{ createHttpDirectoryHandle }, { createExternalDirectoryVault }, { createZeroWriteWitness }, { loadVaultState }] = modules;

  const reader = createExternalDirectoryVault(createHttpDirectoryHandle(`http://127.0.0.1:${port}`));
  const witness = createZeroWriteWitness(reader);
  // The regression the reviewer asked for: when this hands over the unwrapped
  // reader, the witness records no reads and the run must not be able to pass.
  const handedToProxima = options.unwireWitness ? reader : witness.reader;

  try {
    const load = await loadVaultState(handedToProxima);
    const paths = Object.keys(load.revisions ?? {});
    return {
      witness,
      load: {
        ok: true,
        paths,
        counts: {
          projects: load.state.projects.length,
          tasks: load.state.tasks.length,
          events: load.state.events.length,
          problems: load.problems.length,
          records: load.state.projects.length + load.state.tasks.length + load.state.events.length,
        },
      },
    };
  } catch {
    return { witness, load: { ok: false, code: CODES.sourceUnreadable, paths: [], counts: null } };
  }
}

function safeRelative(path) {
  const normalised = String(path).replaceAll('\\', '/');
  return !/^(?:[A-Za-z]:|\/)/.test(normalised) && !normalised.split('/').some((part) => part === '..' || part === '.');
}

function codeFor(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.values(CODES).includes(message) ? message : CODES.bridgeUnreachable;
}

function result({ blockers, stages, aborted, counts, reads }) {
  const codes = [...new Set(blockers)].slice(0, MAX_CODES);
  const status = codes.length === 0 ? 'PASS' : aborted ? 'ABORTED' : 'BLOCKED';
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    status,
    // The transport is part of the claim: a pass here is never Papers evidence.
    transport: 'loopback-agent-bridge',
    papersHosted: false,
    readOnly: true,
    stages,
    blockerCodes: codes,
    observedReads: reads,
    counts: counts ?? null,
    open: ['native-fsa-grant', 'clean-profile-picker', 'real-obsidian-coexistence', 'write-concurrency'],
  };
}

/** CLI entry. Prints the bounded result and nothing else. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = value('--root');
  if (!root) {
    console.error(JSON.stringify({ status: 'BLOCKED', blockerCodes: ['root-not-supplied'] }));
    process.exitCode = 2;
  }
  const report = await runAcceptance({ root, port: Number(value('--port') ?? 0) });
  console.log(JSON.stringify(report, null, 2));
  // Set the code and let the loop drain; process.exit() here races the child's
  // closing stdio and aborts the process instead of reporting the result.
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
