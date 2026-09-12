import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The visual half of an agent acceptance run: asks a live Papers host for layout
 * stability, reads the semantic keys a surface published, runs named visual
 * assertions against real geometry, captures the surface and named elements, and
 * verifies every artifact by re-reading it and re-hashing the bytes.
 *
 * Why this exists next to `agent-accept.mjs`: that harness reads a vault through the
 * loopback bridge and says so in its own result - `papersHosted: false`. The claims it
 * refuses to make are exactly the ones here, so they get their own run rather than a
 * stage inside a transport that cannot support them.
 *
 * What it will not do: substitute anything for the host. No screenshot stands in for a
 * capture, no source reading stands in for `visual.wait`, and a stage that the host
 * declines fails the run instead of being recorded as an open item. The credential rule
 * is the bridge's: the descriptor is a live credential, so it is read, never printed,
 * never written into evidence, and never included in an error message.
 */
export const VISUAL_ACCEPTANCE_SCHEMA_VERSION = 1;

const MAX_CODES = 20;
const MAX_KEYS = 256;
const ARTIFACT_CHUNK_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

/** Papers' own key contract, restated so a violation fails here rather than silently there. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const KEY_MAX_LENGTH = 128;

const CODES = Object.freeze({
  descriptorMissing: 'descriptor-not-supplied',
  controlUnreachable: 'control-plane-unreachable',
  targetNotFound: 'surface-not-found',
  targetAmbiguous: 'surface-ambiguous',
  layoutNotStable: 'layout-not-stable',
  noSemanticKeys: 'no-semantic-keys',
  keyContractViolated: 'semantic-key-violates-contract',
  geometryUnavailable: 'geometry-unavailable',
  assertionMissingElement: 'assertion-missing-element',
  expectedAssertionFailed: 'expected-assertion-failed',
  captureUnavailable: 'capture-unavailable',
  artifactIntegrity: 'artifact-integrity-failed',
  diagnosticFailure: 'diagnostic-failure',
  identityUnavailable: 'identity-unavailable',
});

/** Read one newline-terminated frame at a time: a socket delivery is not a message. */
function createLineReader(socket) {
  let buffer = '';
  const waiting = [];
  let ended = null;
  const settle = () => {
    while (waiting.length > 0) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      waiting.shift().resolve(line);
    }
    if (ended) while (waiting.length > 0) waiting.shift().reject(ended);
  };
  socket.on('data', (chunk) => { buffer += chunk; settle(); });
  socket.on('end', () => { ended = new Error('control connection ended before a complete response'); settle(); });
  socket.on('error', (error) => { ended = error; settle(); });
  return {
    readLine() {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return Promise.resolve(line);
      }
      if (ended) return Promise.reject(ended);
      return new Promise((resolveLine, rejectLine) => { waiting.push({ resolve: resolveLine, reject: rejectLine }); });
    },
  };
}

export async function connectControl(descriptor) {
  const socket = createConnection(descriptor.pipe);
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  const reader = createLineReader(socket);
  let nextId = 0;
  const pending = new Map();
  let ended = null;
  void (async () => {
    try {
      while (!ended) {
        const frame = JSON.parse(await reader.readLine());
        if (frame?.type === 'event') continue;
        const entry = pending.get(frame?.id);
        if (!entry) continue;
        pending.delete(frame.id);
        entry(frame);
      }
    } catch (error) {
      ended = error;
      for (const reject of pending.values()) reject(error);
      pending.clear();
    }
  })();
  return {
    call(method, params = {}) {
      if (ended) return Promise.reject(ended);
      nextId += 1;
      const id = nextId;
      const response = new Promise((resolveCall, rejectCall) => {
        pending.set(id, (frame) => (frame.ok ? resolveCall(frame.result) : rejectCall(new Error(`${method}: ${frame.error ?? 'refused'}`))));
      });
      socket.write(`${JSON.stringify({ id, token: descriptor.token, protocolVersion: descriptor.protocolVersion, method, params })}\n`);
      return response;
    },
    close() { socket.end(); },
  };
}

async function readArtifact(connection, metadata) {
  if (!metadata || typeof metadata.artifactId !== 'string' || !Number.isInteger(metadata.size) || metadata.size < 1) {
    throw new Error('the host returned no usable artifact metadata');
  }
  if (metadata.size > MAX_ARTIFACT_BYTES) throw new Error('artifact exceeds the harness bound');
  const chunks = [];
  let offset = 0;
  while (true) {
    const chunk = await connection.call('visual.artifact.read', { artifactId: metadata.artifactId, offset, length: ARTIFACT_CHUNK_BYTES });
    const bytes = Buffer.from(chunk.bytesBase64, 'base64');
    if (chunk.offset !== offset || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > metadata.size
      || (!chunk.done && chunk.nextOffset <= offset) || (chunk.done && chunk.nextOffset !== metadata.size)) {
      throw new Error('artifact chunk sequence is invalid');
    }
    chunks.push(bytes);
    offset = chunk.nextOffset;
    if (chunk.done) break;
  }
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== metadata.size || sha256 !== metadata.sha256) throw new Error('artifact bytes do not match the host metadata');
  return { bytes: bytes.length, sha256 };
}

export async function runVisualAcceptance(options = {}) {
  const descriptorPath = options.descriptor ? resolve(options.descriptor) : '';
  const stages = {};
  const blockers = [];
  const artifacts = {};
  let hostIdentity = null;
  const fail = (code) => { if (!blockers.includes(code)) blockers.push(code); };

  const finish = () => {
    const codes = blockers.slice(0, MAX_CODES);
    return {
      schemaVersion: VISUAL_ACCEPTANCE_SCHEMA_VERSION,
      status: codes.length === 0 ? 'PASS' : 'BLOCKED',
      // The transport is part of the claim, and here it is the strong one.
      transport: 'papers-developer-control',
      papersHosted: true,
      readOnly: true,
      surface: options.surface ? { surfaceId: options.surface } : null,
      windowId: Number.isInteger(options.window) ? options.window : null,
      stages,
      blockerCodes: codes,
      counts: null,
      keys: null,
      assertions: null,
      artifacts,
      hostIdentity: null,
      observedRecords: null,
      // Named so a reader can see what this run is not: it never writes to a record,
      // and it never substitutes a screenshot, a source reading or a stub for a host answer.
      open: ['native-fsa-grant', 'real-obsidian-coexistence'],
    };
  };

  if (!descriptorPath) { fail(CODES.descriptorMissing); return finish(); }

  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  } catch {
    fail(CODES.controlUnreachable);
    return finish();
  }

  let connection;
  try {
    connection = await connectControl(descriptor);
  } catch {
    // Deliberately not including the error: it can carry the pipe address.
    fail(CODES.controlUnreachable);
    return finish();
  }

  try {
    try {
      const hostProcess = await connection.call('inspect.process');
      stages.identity = 'PASS';
      hostIdentity = {
        version: hostProcess?.build?.version ?? null,
        commit: hostProcess?.build?.commit ?? null,
        packaged: hostProcess?.build?.packaged ?? null,
        appInstanceId: hostProcess?.appInstanceId ?? null,
        executableStatus: hostProcess?.executableIdentity?.status ?? null,
      };
    } catch {
      stages.identity = 'FAIL';
      fail(CODES.identityUnavailable);
    }

    // ---- target -------------------------------------------------------------
    const surfaces = await connection.call('inspect.surfaces');
    const inWindow = surfaces.filter((surface) => !Number.isInteger(options.window) || surface.windowId === options.window);
    let target = null;
    if (options.surface) {
      target = inWindow.find((surface) => surface.surfaceId === options.surface) ?? null;
      if (!target) fail(CODES.targetNotFound);
    } else {
      const candidates = inWindow.filter((surface) => surface.kind === 'project'
        && (!options.project || surface.projectId === options.project)
        && surface.presentation === 'visible');
      if (candidates.length > 1) fail(CODES.targetAmbiguous);
      else if (candidates.length === 0) fail(CODES.targetNotFound);
      else target = candidates[0];
    }
    if (!target) { stages.target = 'FAIL'; return finish(); }
    stages.target = 'PASS';
    const surfaceTarget = { windowId: target.windowId, surfaceId: target.surfaceId };

    // ---- stability ----------------------------------------------------------
    const wait = await connection.call('visual.wait', {
      ...surfaceTarget,
      until: 'layout-stable',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    stages.stability = wait?.status === 'layout-stable' ? 'PASS' : 'FAIL';
    if (stages.stability === 'FAIL') fail(CODES.layoutNotStable);

    // ---- semantic keys ------------------------------------------------------
    const elements = await connection.call('inspect.visual.elements', surfaceTarget);
    const keys = (elements?.elements ?? []).map((element) => element.key);
    const observations = (elements?.elements ?? []).filter((element) => element && typeof element === 'object' && 'boundsCss' in element).length;
    const violations = keys.filter((key) => typeof key !== 'string' || key.length < 1 || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key));
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    const minimum = options.minKeys ?? 1;
    if (keys.length < minimum) fail(CODES.noSemanticKeys);
    if (violations.length > 0 || duplicates.length > 0) fail(CODES.keyContractViolated);
    stages.keys = keys.length >= minimum && violations.length === 0 && duplicates.length === 0 ? 'PASS' : 'FAIL';

    // ---- assertions ---------------------------------------------------------
    const preferred = ['app-root', 'cockpit-navigation', 'surface-switcher', 'project-navigation'];
    const requested = options.assertKeys?.length ? options.assertKeys : preferred.filter((key) => keys.includes(key));
    const assertions = requested.map((key) => ({ kind: 'visible', elementKey: key }));
    if (keys.includes('app-root')) {
      const inner = preferred.find((key) => key !== 'app-root' && keys.includes(key));
      if (inner) assertions.push({ kind: 'inside', elementKey: inner, containerKey: 'app-root' });
    }
    let assertionOutput = null;
    let assertionFailure = false;
    if (assertions.length === 0) {
      // No key this surface published can carry an assertion: the stage cannot be
      // reported as passed by default, and it cannot be skipped either.
      stages.assertions = 'FAIL';
      assertionFailure = true;
      fail(CODES.geometryUnavailable);
    } else {
      assertionOutput = await connection.call('visual.assert', { ...surfaceTarget, assertions });
      const results = assertionOutput?.assertions ?? [];
      const expected = new Set(options.expectPass ?? []);
      const missingElement = assertions.some((_, index) => results[index]?.reason === 'missing-element');
      const expectedFailures = assertions.filter((assertion, index) => expected.has(assertion.elementKey) && results[index]?.passed !== true);
      if (assertionOutput?.available !== true) { assertionFailure = true; fail(CODES.geometryUnavailable); }
      if (missingElement) { assertionFailure = true; fail(CODES.assertionMissingElement); }
      if (expectedFailures.length > 0) { assertionFailure = true; fail(CODES.expectedAssertionFailed); }
      stages.assertions = assertionFailure ? 'FAIL' : 'PASS';
    }

    // ---- captures -----------------------------------------------------------
    try {
      const capture = await connection.call('capture.surface', surfaceTarget);
      if (!capture?.png) throw new Error('no artifact');
      artifacts.surface = await readArtifact(connection, capture.png);
      stages.surfaceCapture = 'PASS';
    } catch {
      stages.surfaceCapture = 'FAIL';
      fail(CODES.captureUnavailable);
    }

    const elementTargets = (options.elementKeys?.length ? options.elementKeys : requested).slice(0, 8);
    artifacts.elements = {};
    let elementFailures = 0;
    for (const key of elementTargets) {
      try {
        const capture = await connection.call('capture.element', { ...surfaceTarget, elementKey: key, paddingCssPx: 0 });
        if (!capture?.png) throw new Error('no artifact');
        artifacts.elements[key] = await readArtifact(connection, capture.png);
      } catch {
        artifacts.elements[key] = { bytes: null, sha256: null };
        elementFailures += 1;
      }
    }
    stages.elementCaptures = elementTargets.length > 0 && elementFailures === 0 ? 'PASS' : 'FAIL';
    if (elementFailures > 0) fail(CODES.captureUnavailable);

    // ---- diagnostics --------------------------------------------------------
    const diagnostics = await connection.call('inspect.visual.diagnostics', surfaceTarget);
    const failures = diagnostics.filter((record) => record?.payload?.kind === 'renderer-gone' || record?.payload?.kind === 'console');
    stages.diagnostics = failures.length === 0 ? 'PASS' : 'FAIL';
    if (failures.length > 0) fail(CODES.diagnosticFailure);

    const result = finish();
    result.surface = { surfaceId: target.surfaceId, projectId: target.projectId, windowId: target.windowId, presentation: target.presentation };
    result.hostIdentity = hostIdentity;
    result.counts = {
      keys: keys.length,
      distinctKeys: new Set(keys).size,
      keysWithGeometry: observations,
      assertions: assertions.length,
      records: diagnostics.length,
      captures: Object.keys(artifacts.elements ?? {}).length + (artifacts.surface ? 1 : 0),
    };
    result.keys = keys.slice(0, MAX_KEYS);
    result.assertions = assertionOutput ? {
      available: assertionOutput.available === true,
      allPassed: assertionOutput.allPassed === true,
      results: (assertionOutput.assertions ?? []).map((entry, index) => ({
        kind: entry.kind,
        elementKey: assertions[index]?.elementKey ?? null,
        passed: entry.passed === true,
        ...(entry.reason ? { reason: entry.reason } : {}),
      })),
    } : null;
    result.observedRecords = diagnostics.slice(-5).map((record) => ({ sequence: record.sequence, phase: record.payload?.phase ?? record.payload?.kind ?? null }));
    return result;
  } finally {
    connection.close();
  }
}


/** The project's own build identity, read from the generated module the page carries. */
export async function readBuildIdentity(path = fileURLToPath(new URL('../src/browser/generated/buildIdentity.generated.ts', import.meta.url))) {
  try {
    const text = await readFile(path, 'utf8');
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

/** CLI entry. Prints the bounded result and nothing else; the exit code is the verdict. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const many = (name) => args.flatMap((argument, index) => (argument === name && args[index + 1] ? [args[index + 1]] : []));
  const descriptor = value('--descriptor') ?? process.env.PAPERS_DEV_CONTROL_DESCRIPTOR;
  if (!descriptor) {
    console.error(JSON.stringify({ status: 'BLOCKED', blockerCodes: [CODES.descriptorMissing] }));
    process.exitCode = 2;
  } else {
    const report = await runVisualAcceptance({
      descriptor,
      window: value('--window') === undefined ? undefined : Number(value('--window')),
      surface: value('--surface'),
      project: value('--project'),
      minKeys: value('--min-keys') === undefined ? undefined : Number(value('--min-keys')),
      timeoutMs: value('--timeout-ms') === undefined ? undefined : Number(value('--timeout-ms')),
      assertKeys: many('--assert'),
      expectPass: many('--expect-pass'),
      elementKeys: many('--element'),
    });
    report.projectIdentity = await readBuildIdentity(value('--identity'));
    const output = value('--output');
    if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}
