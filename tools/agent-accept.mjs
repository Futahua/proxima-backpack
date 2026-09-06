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

/**
 * Preflight blockers a bridge-backed run cannot clear, and must not pretend to.
 * Kept as an explicit set so adding one is a deliberate, reviewable act.
 */
const EXPECTED_OPEN_BLOCKERS = new Set(['coexistence-simulation-missing', 'host-capability-unresolved']);

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
  layoutUnresolved: 'layout-unresolved',
  layoutAmbiguous: 'layout-ambiguous',
  acceptanceFailed: 'acceptance-6j-failed',
  runbookNotReady: 'runbook-6l-not-ready',
  preflightNotReady: 'preflight-6n-not-ready',
  buildStale: 'build-identity-stale',
  scanIncomplete: 'record-scan-incomplete',
  unaccounted: 'unaccounted-record-candidates',
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

    const read = await readThroughWitness(port, options);
    const { witness, load } = read;
    stages.layout = read.detection?.kind === 'preferred' || read.detection?.kind === 'legacy' ? 'PASS' : 'FAIL';
    stages.baselineRead = load.ok ? 'PASS' : 'FAIL';
    if (!load.ok) fail(load.code ?? CODES.loadFailed, { abort: load.code === CODES.layoutAmbiguous });

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

    // Completeness before verdicts. Counting records is not enough: a run once
    // passed while every project vanished, because a different kind's 271 records
    // kept the total non-zero. A scan that did not finish means the contents are
    // unknown, which is a different claim from "looked, found nothing" — and a
    // candidate that neither loaded nor was explicitly rejected is a record that
    // disappeared with nobody saying why.
    const census = read.census;
    if (census) {
      const failedScans = Object.entries(census).filter(([, kind]) => kind.status === 'failed').map(([name]) => name);
      const unaccounted = Object.entries(census).filter(([, kind]) => kind.unaccountedCandidates > 0).map(([name]) => name);
      stages.scanCompleteness = failedScans.length === 0 ? 'PASS' : 'FAIL';
      stages.candidateAccounting = unaccounted.length === 0 ? 'PASS' : 'FAIL';
      if (failedScans.length > 0) fail(CODES.scanIncomplete, { abort: true });
      if (unaccounted.length > 0) fail(CODES.unaccounted, { abort: true });
    }

    // Only now, with the instruments having reported, run the evaluators the
    // browser depends on. Two of the facts 6N needs are things this run genuinely
    // observed — nothing was written, and no unsafe path appeared — so they are
    // passed as observations. The two it did not observe, the peer-writer
    // simulation and the host-capability question, stay whatever the caller
    // declared, which for an ordinary run is nothing.
    const observed = {
      writesAttempted: witness.violations.length,
      writerMethodsCalled: [...witness.violations],
      coexistence: {
        ...normaliseCoexistence(options.coexistence),
        zeroWrites: stages.zeroWriteWitness === 'PASS' && stages.zeroWriteEffect === 'PASS',
        sourceBoundsValid: stages.pathSafety === 'PASS',
      },
    };
    const evaluators = read.evaluate ? read.evaluate(observed) : null;

    if (evaluators) {
      // 6J's overall `passed` folds in external-edit, rename/delete and Obsidian
      // stages that a single baseline read cannot observe and that remain OPEN by
      // design. The baseline condition is the one this run is entitled to assert.
      const baseline = evaluators.acceptance.stages.baselineRead?.verdict;
      stages.acceptance6J = baseline === 'PASS' ? 'PASS' : 'FAIL';
      if (baseline !== 'PASS') fail(CODES.acceptanceFailed);

      stages.runbook6L = evaluators.runbook.status === 'READY' ? 'PASS' : 'FAIL';
      if (evaluators.runbook.status !== 'READY') fail(CODES.runbookNotReady, { abort: evaluators.runbook.status === 'ABORTED' });

      // 6N is the gate for the *native* grant decision, which a loopback bridge
      // cannot resolve by construction: it performs no peer-writer simulation and
      // answers no host-capability question. Those two blockers are therefore
      // expected rather than excused — they are reported in `openBlockers` so a
      // reader sees exactly what was set aside, and anything else fails the run.
      const unexpected = evaluators.preflight.blockerCodes.filter((code) => !EXPECTED_OPEN_BLOCKERS.has(code));
      stages.preflight6N = unexpected.length === 0 ? 'PASS' : 'FAIL';
      if (unexpected.length > 0) fail(CODES.preflightNotReady, { abort: evaluators.preflight.status === 'ABORTED' });

      if (read.buildSha && options.expectedBuildSha && read.buildSha !== options.expectedBuildSha) {
        stages.buildIdentity = 'FAIL';
        fail(CODES.buildStale);
      } else if (read.buildSha) {
        stages.buildIdentity = 'PASS';
      }
    }

    return result({
      blockers,
      stages,
      aborted,
      counts: load.counts,
      reads: witness.reads.length,
      layout: read.detection?.kind ?? null,
      evaluators,
      census: read.census ?? null,
    });
  } catch (error) {
    fail(codeFor(error));
    return result({ blockers, stages, aborted, counts: null, reads: 0, layout: null, evaluators: null, census: null });
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

function loadBuiltModule(relative) {
  // Fail closed rather than falling back to a dynamic import. Gate 6P wants
  // certainty about which artifact executed more than portability to an older
  // loader, and a fallback would reintroduce exactly the runner-graph ambiguity
  // this exists to remove.
  return requireBuilt(fileURLToPath(new URL(relative, BUILD)));
}

async function readThroughWitness(port, options) {
  let modules;
  try {
    modules = [
      loadBuiltModule('adapters/httpDirectory.js'),
      loadBuiltModule('adapters/externalDirectoryVault.js'),
      loadBuiltModule('app/zeroWriteWitness.js'),
      loadBuiltModule('app/vaultRepository.js'),
      loadBuiltModule('app/vaultLayout.js'),
      loadBuiltModule('app/readOnlyProjection.js'),
      loadBuiltModule('app/actionProtocol.js'),
      loadBuiltModule('app/inspection.js'),
      loadBuiltModule('app/realVaultAcceptance.js'),
      loadBuiltModule('app/realVaultRunbook.js'),
      loadBuiltModule('app/creatorVaultPreflight.js'),
      loadBuiltModule('browser/generated/buildIdentity.generated.js'),
    ];
  } catch {
    // Never report a missing build as a transport failure; run `npm run build`.
    throw new Error(CODES.modulesUnavailable);
  }
  const [
    { createHttpDirectoryHandle, createHttpPresenceProbe },
    { createExternalDirectoryVault },
    { createZeroWriteWitness },
    { loadVaultState },
    { detectLayout },
    { createReadOnlyProjection },
    { createActionDispatcher },
    { createInspectionProjection },
    { evaluateRealVaultAcceptance },
    { evaluateRealVaultRunbook },
    { evaluateCreatorVaultPreflight },
    { BUILD_IDENTITY },
  ] = modules;

  const base = `http://127.0.0.1:${port}`;
  // Presence comes through the adapter chain, not bolted on here: a capability the
  // harness patches onto a reader is one the browser path silently lacks, and one
  // that can disappear without any test noticing.
  const reader = createExternalDirectoryVault(createHttpDirectoryHandle(base), {
    presence: createHttpPresenceProbe(base),
  });
  const witness = createZeroWriteWitness(reader);
  // The regression the reviewer asked for: when this hands over the unwrapped
  // reader, the witness records no reads and the run must not be able to pass.
  const handedToProxima = options.unwireWitness ? reader : witness.reader;

  // Which layout, decided by a narrow read-only probe of the two canonical roots.
  // Never a search of the creator's tree, and never a silent choice when both exist.
  const detection = options.layout
    ? { kind: options.layout, layout: undefined, found: [options.layout] }
    : await detectLayout(handedToProxima);
  if (detection.kind === 'ambiguous') {
    return { witness, load: { ok: false, code: CODES.layoutAmbiguous, paths: [], counts: null }, detection };
  }
  if (detection.kind === 'none') {
    return { witness, load: { ok: false, code: CODES.layoutUnresolved, paths: [], counts: null }, detection };
  }

  try {
    const load = await loadVaultState(handedToProxima, detection.layout ? { layout: detection.layout } : {});

    // Materials for the hosted evaluators. They are run by the caller, once the
    // zero-write and path-safety instruments have actually reported, so their input
    // is this run's observations rather than an assumption made before the checks.
    const projection = createReadOnlyProjection({
      sourceRevision: 1,
      lastSuccessfulRefreshRevision: 1,
      refreshState: 'idle',
      stale: false,
      lastRefreshReason: null,
      lastRefreshProblemCode: null,
      pendingRefreshCount: 0,
      load,
    });
    const dispatcher = createActionDispatcher({
      state: projection.state,
      problems: projection.problems,
      revisions: projection.revisions,
      mode: 'live',
      initialSourceRevision: projection.generation,
    });
    const inspection = createInspectionProjection(dispatcher.snapshot(), BUILD_IDENTITY, projection.health);

    return {
      witness,
      detection,
      buildSha: BUILD_IDENTITY.gitSha,
      evaluate: (observations) => {
        const acceptance = evaluateRealVaultAcceptance({
          build: BUILD_IDENTITY,
          // Bridge-backed: an external source, granted by the operator supplying the
          // root, already bootstrapped. Reported as observed, never as aspiration.
          startup: { startupSourceMode: 'external', restoredHandlePresent: true, bootstrapStatus: 'ready' },
          session: { sourceMode: 'external', sourceGeneration: projection.generation, transitionState: 'stable' },
          projection,
          inspection,
          writeInvariant: { writesAttempted: observations.writesAttempted, writerMethodsCalled: observations.writerMethodsCalled },
        });
        const runbook = evaluateRealVaultRunbook({ report: acceptance, expectedBuildSha: BUILD_IDENTITY.gitSha });
        const preflight = evaluateCreatorVaultPreflight({
          acceptance,
          runbook,
          coexistence: observations.coexistence,
          expectedBuildSha: BUILD_IDENTITY.gitSha,
        });
        return { acceptance, runbook, preflight };
      },
      census: load.census ?? null,
      load: {
        ok: true,
        paths: Object.keys(load.revisions ?? {}),
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
    return { witness, detection, load: { ok: false, code: CODES.sourceUnreadable, paths: [], counts: null } };
  }
}

/** Coexistence readiness is only ever what a caller declared, coerced strictly. */
function normaliseCoexistence(declared) {
  const value = declared ?? {};
  return {
    passed: value.passed === true,
    zeroWrites: value.zeroWrites === true,
    sourceBoundsValid: value.sourceBoundsValid === true,
    hostCapabilityResolved: value.hostCapabilityResolved === true,
  };
}

function safeRelative(path) {
  const normalised = String(path).replaceAll('\\', '/');
  return !/^(?:[A-Za-z]:|\/)/.test(normalised) && !normalised.split('/').some((part) => part === '..' || part === '.');
}

function codeFor(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.values(CODES).includes(message) ? message : CODES.bridgeUnreachable;
}

function result({ blockers, stages, aborted, counts, reads, layout = null, evaluators = null, census = null }) {
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
    layout,
    // Per-kind scan status and candidate accounting: what the transport saw, and
    // what became of every record-shaped file it found.
    census,
    // The three hosted evaluators' own verdicts, so a reader can see that this run
    // agreed with them rather than with a verdict this harness invented.
    verdicts: evaluators
      ? {
          // The baseline condition this run is entitled to assert, kept separate
          // from 6J's overall pass, which folds in stages a single read cannot see.
          acceptance6JBaseline: evaluators.acceptance.stages.baselineRead?.verdict ?? 'FAIL',
          // Why the baseline failed, in the evaluator's own codes. Without this the
          // operator sees "acceptance-6j-failed" and has nowhere to go.
          baselineFailures: (evaluators.acceptance.stages.baselineRead?.failureCodes ?? []).slice(0, MAX_CODES),
          acceptance6JOverall: evaluators.acceptance.passed ? 'PASS' : 'FAIL',
          runbook6L: evaluators.runbook.status,
          preflight6N: evaluators.preflight.status,
          // Blockers set aside because this transport cannot clear them, and the
          // rest, which would fail the run.
          openBlockers: evaluators.preflight.blockerCodes.filter((code) => EXPECTED_OPEN_BLOCKERS.has(code)),
          preflightBlockers: evaluators.preflight.blockerCodes.filter((code) => !EXPECTED_OPEN_BLOCKERS.has(code)).slice(0, MAX_CODES),
        }
      : null,
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
