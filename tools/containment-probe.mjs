import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectControl } from './papers-visual-accept.mjs';

/**
 * Measures whether a Backpack page is actually contained by the host that serves it, using a
 * probe project (`tools/containment-probe/`) whose answers travel back through the one channel
 * a Papers host reads: semantic keys. Gate 20's "still sandboxed" box had no exact host
 * configuration or acceptance evidence behind it; this is the evidence, and it fails when the
 * containment stops being true rather than when a reader stops believing it.
 *
 * What it refuses to do: run in the shipped product (the probe is a separate project registered
 * into a disposable profile), read the page's own prose as proof, or treat a *cross-origin*
 * refusal as a CSP measurement - a same-origin fetch and a same-origin frame are the two probes
 * that only a policy can refuse.
 */
export const CONTAINMENT_PROBE_SCHEMA_VERSION = 1;

const PROBE_PROJECT_ROOT = fileURLToPath(new URL('./containment-probe/', import.meta.url));
const DEFAULT_TIMEOUT_MS = 5000;

/** The answers this probe treats as containment. Each name is a deliberate, narrow claim. */
const EXPECTATIONS = [
  { question: 'node', accept: ['no-node'], claim: 'no Node runtime is visible to the page' },
  { question: 'fetch', accept: ['fetch-blocked'], claim: "a same-origin fetch is refused, so connect-src is 'none'" },
  { question: 'eval', accept: ['eval-blocked'], claim: "indirect eval is refused, so script-src has no 'unsafe-eval'" },
  { question: 'frame', accept: ['frame-blocked'], claim: "an embedded frame is refused, so frame-src is 'none'" },
  { question: 'storage', accept: ['storage-isolated'], claim: 'this origin enumerates no other Backpack database' },
  { question: 'origin', containsProjectId: true, claim: 'the page runs on the papers-backpack origin of its own Backpack id' },
];

const CODES = Object.freeze({
  descriptorMissing: 'descriptor-not-supplied',
  controlUnreachable: 'control-plane-unreachable',
  surfaceNotFound: 'surface-not-found',
  projectMissing: 'probe-project-missing',
  noAnswers: 'probe-published-no-answers',
  containmentFailed: 'containment-probe-failed',
});

export async function readProbeProject() {
  const manifest = JSON.parse(await readFile(resolve(PROBE_PROJECT_ROOT, 'project.json'), 'utf8'));
  const page = await readFile(resolve(PROBE_PROJECT_ROOT, 'public/index.html'), 'utf8');
  return { manifest, page };
}

/** Register the probe into a profile's bindings so a host will serve it. */
export async function registerProbe(profileDataDirectory, projectRoot = PROBE_PROJECT_ROOT) {
  const { manifest } = await readProbeProject();
  const registryPath = resolve(profileDataDirectory, 'registry.json');
  const projectsPath = resolve(profileDataDirectory, 'backpack-projects.json');
  const backpackDirectory = resolve(profileDataDirectory, 'backpacks', manifest.backpackId);
  await mkdir(backpackDirectory, { recursive: true });

  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  if (!registry.backpacks.some((entry) => entry.id === manifest.backpackId)) {
    registry.backpacks.push({
      id: manifest.backpackId,
      name: 'Backpack containment probe',
      type: 'environment',
      createdAt: '2026-09-12T00:00:00.000Z',
      lastEnteredAt: null,
      archived: false,
      workspacePath: null,
    });
  }
  const projects = JSON.parse(await readFile(projectsPath, 'utf8'));
  projects.projects[manifest.backpackId] = { root: resolve(projectRoot) };

  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFile(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
  await writeFile(resolve(backpackDirectory, 'backpack.json'), `${JSON.stringify({
    workspacePath: null,
    type: 'environment',
    archived: false,
    createdAt: '2026-09-12T00:00:00.000Z',
    lastEnteredAt: null,
    id: manifest.backpackId,
    schemaVersion: 1,
    name: 'Backpack containment probe',
  }, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Read the probe's answers from the host's own inspection channels, then judge them. */
export async function runContainmentProbe(options = {}) {
  const report = {
    schemaVersion: CONTAINMENT_PROBE_SCHEMA_VERSION,
    status: 'BLOCKED',
    transport: 'papers-developer-control',
    papersHosted: true,
    readOnly: true,
    surface: null,
    answers: {},
    expectations: [],
    consoleRecords: [],
    observedRecords: null,
    hostIdentity: null,
    blockerCodes: [],
    keys: [],
  };
  const fail = (code) => { if (!report.blockerCodes.includes(code)) report.blockerCodes.push(code); };
  const settle = () => { report.status = report.blockerCodes.length === 0 ? 'PASS' : 'BLOCKED'; return report; };

  if (!options.descriptor) { fail(CODES.descriptorMissing); return settle(); }
  let manifest;
  try {
    manifest = (await readProbeProject()).manifest;
  } catch {
    fail(CODES.projectMissing);
    return settle();
  }

  let connection;
  try {
    const descriptor = JSON.parse(await readFile(resolve(options.descriptor), 'utf8'));
    connection = await connectControl(descriptor);
  } catch {
    // Deliberately without the error: it can carry the pipe address.
    fail(CODES.controlUnreachable);
    return settle();
  }

  try {
    try {
      const hostProcess = await connection.call('inspect.process');
      report.hostIdentity = {
        version: hostProcess?.build?.version ?? null,
        commit: hostProcess?.build?.commit ?? null,
        packaged: hostProcess?.build?.packaged ?? null,
      };
    } catch { /* identity is recorded when the host answers; its absence is not a blocker here */ }

    let surfaceId = options.surface ?? null;
    if (options.open) {
      // Every open leaves the previous surface hidden, so a probe run opens its own project.
      const opened = await connection.call('workspace.open', { windowId: options.window, projectId: manifest.backpackId });
      surfaceId = opened.surfaceId;
      await connection.call('visual.wait', { windowId: options.window, surfaceId, until: 'layout-stable', timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }).catch(() => null);
    }
    if (!surfaceId) { fail(CODES.surfaceNotFound); return settle(); }
    const target = { windowId: options.window, surfaceId };
    report.surface = { surfaceId, projectId: manifest.backpackId, windowId: options.window };

    const deadline = Date.now() + (options.waitMs ?? 15000);
    let keys = [];
    while (Date.now() < deadline) {
      let elements;
      try {
        elements = await connection.call('inspect.visual.elements', target);
      } catch {
        // A surface the host does not accept is answered with a bounded code, not a stack trace.
        fail(CODES.surfaceNotFound);
        return settle();
      }
      keys = (elements?.elements ?? []).map((element) => element.key);
      if (keys.some((key) => key.startsWith('probe-') && !key.startsWith('probe-report') && !key.startsWith('probe-answers'))) break;
      await new Promise((wait) => setTimeout(wait, 1000));
    }
    report.keys = keys;
    if (!keys.some((key) => key.startsWith('probe-'))) { fail(CODES.noAnswers); return settle(); }

    // The answer channel: one key per question, `probe-<question>-<answer>`.
    const answers = {};
    for (const key of keys) {
      const match = /^probe-([a-zA-Z]+)-(.+)$/.exec(key);
      if (match && match[1] !== 'report' && match[1] !== 'answers') answers[match[1]] = match[2];
    }
    report.answers = answers;

    for (const expectation of EXPECTATIONS) {
      const answer = answers[expectation.question] ?? null;
      const ok = expectation.containsProjectId
        ? typeof answer === 'string' && answer.includes(manifest.backpackId)
        : expectation.accept.includes(answer);
      report.expectations.push({ question: expectation.question, answer, claim: expectation.claim, ok });
      if (!ok) fail(CODES.containmentFailed);
    }

    const diagnostics = await connection.call('inspect.visual.diagnostics', target);
    report.consoleRecords = diagnostics
      .filter((record) => record?.payload?.kind === 'console')
      .slice(-6)
      .map((record) => ({ level: record.payload?.level ?? null, message: String(record.payload?.message ?? '').slice(0, 200) }));
    report.observedRecords = diagnostics.slice(-4).map((record) => ({ sequence: record.sequence, phase: record.payload?.phase ?? record.payload?.kind ?? null }));
    return settle();
  } finally {
    connection.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const descriptor = value('--descriptor') ?? process.env.PAPERS_DEV_CONTROL_DESCRIPTOR;
  if (value('--register')) {
    const manifest = await registerProbe(value('--register'));
    console.log(JSON.stringify({ registered: manifest.backpackId, root: PROBE_PROJECT_ROOT }, null, 2));
    process.exitCode = 0;
  } else if (!descriptor) {
    console.error(JSON.stringify({ status: 'BLOCKED', blockerCodes: [CODES.descriptorMissing] }));
    process.exitCode = 2;
  } else {
    const report = await runContainmentProbe({
      descriptor,
      window: Number(value('--window') ?? 1),
      surface: value('--surface'),
      open: value('--open') === 'true',
      waitMs: value('--wait-ms') === undefined ? undefined : Number(value('--wait-ms')),
    });
    const output = value('--output');
    if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}
