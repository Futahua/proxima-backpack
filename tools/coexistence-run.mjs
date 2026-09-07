import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcceptance } from './agent-accept.mjs';

/**
 * Gate 6R — real Obsidian coexistence, run unattended.
 *
 *     npm run agent:coexist -- --root <vault> --obsidian <Obsidian.exe>
 *
 * The claim this produces is narrow and stated as such: the filesystem mutation was
 * executed by the running Obsidian process through its `app.vault` API. It is *not*
 * a claim that a human authored the edit. Blurring those two would be the easiest
 * way to make this gate say more than it proved.
 *
 * The protocol, in order, because cleanup is part of the gate rather than tidying
 * afterwards:
 *
 *   1. Proxima baseline, read-only, through the audited bridge.
 *   2. Install the one-shot probe plugin and enable it, backing up the vault's
 *      plugin configuration first.
 *   3. For each of create, modify, delete: start Obsidian, wait for the plugin to
 *      record that step in its own data, stop Obsidian, then have Proxima observe.
 *   4. Remove the plugin, restore the configuration byte-for-byte, and verify that
 *      neither the plugin nor its probe record remains.
 *
 * Probe-record mutations are performed by Obsidian. Harness setup/cleanup also
 * installs/removes its disposable probe and edits/restores plugin configuration;
 * those tool-owned mutations are separately scoped and byte-for-byte restored.
 * Proxima only ever reads, and the zero-write witness in each observation proves it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_ID = 'proxima-coexistence-probe';
const PROBE_RECORD = '-Hide/Proxima/events/proxima-6r-probe.md';
const STEPS = ['create', 'modify', 'delete'];
const STEP_TIMEOUT_MS = 120_000;

export async function runCoexistence(options = {}) {
  const root = options.root;
  const obsidian = options.obsidian;
  if (!root) throw new Error('a --root is required; this harness never discovers or guesses one');
  if (!obsidian) throw new Error('an --obsidian executable path is required');

  const pluginsDir = join(root, '.obsidian', 'plugins');
  const probeDir = join(pluginsDir, PROBE_ID);
  const enabledFile = join(root, '.obsidian', 'community-plugins.json');
  const stages = {};
  const observations = [];
  let enabledBackup = null;
  let installed = false;

  try {
    // 1. Baseline. If Proxima cannot read this vault cleanly there is nothing to
    //    observe a change against.
    const baseline = await runAcceptance({ root });
    stages.baseline = baseline.status === 'PASS' ? 'PASS' : 'FAIL';
    if (baseline.status !== 'PASS') {
      return report({ stages, observations, blockers: ['baseline-not-clean'], baseline });
    }

    // 2. Install, remembering exactly what was there before.
    // Launching with no arguments is only safe if Obsidian's own registry says this
    // vault is the one it will reopen. Checked rather than assumed: opening some
    // other vault would mean mutating a directory nobody authorised.
    const registered = await vaultIsObsidiansOpenVault(root);
    stages.vaultRegistry = registered ? 'PASS' : 'FAIL';
    if (!registered) {
      return report({ stages, observations, blockers: ['vault-not-obsidians-open-vault'], baseline });
    }

    enabledBackup = await readFile(enabledFile, 'utf8').catch(() => null);
    await installProbe(probeDir);
    await enableProbe(enabledFile, enabledBackup);
    installed = true;
    stages.install = 'PASS';

    // 3. One Obsidian launch per mutation, each waiting on the plugin's own record
    //    rather than on a timer, so the evidence says what actually happened.
    for (const step of STEPS) {
      const completed = await runObsidianUntilStep(obsidian, root, probeDir, step);
      if (!completed.ok) {
        stages[`obsidian:${step}`] = 'FAIL';
        const reason = completed.launchFailed ?? `obsidian-step-${step}-not-recorded`;
        return report({ stages, observations, blockers: [reason], baseline });
      }
      stages[`obsidian:${step}`] = 'PASS';

      const observed = await runAcceptance({ root });
      observations.push({
        step,
        pluginOutcome: completed.entry?.outcome ?? 'unknown',
        proximaStatus: observed.status,
        events: observed.counts?.events ?? null,
        probePresent: await exists(join(root, PROBE_RECORD)),
        eventCensus: observed.census?.event ?? null,
        zeroWrite: observed.stages?.zeroWriteWitness === 'PASS' && observed.stages?.zeroWriteEffect === 'PASS',
      });
    }
  } finally {
    // 4. Cleanup is part of the gate. It runs even if a step failed.
    if (installed) {
      await rm(probeDir, { recursive: true, force: true }).catch(() => {});
      if (enabledBackup === null) await rm(enabledFile, { force: true }).catch(() => {});
      else await writeFile(enabledFile, enabledBackup, 'utf8').catch(() => {});
    }
  }

  const pluginGone = !(await exists(probeDir));
  const recordGone = !(await exists(join(root, PROBE_RECORD)));
  const configRestored = (await readFile(enabledFile, 'utf8').catch(() => null)) === enabledBackup;
  stages.cleanup = pluginGone && recordGone && configRestored ? 'PASS' : 'FAIL';

  const blockers = [];
  if (!pluginGone) blockers.push('probe-plugin-not-removed');
  if (!recordGone) blockers.push('probe-record-not-removed');
  if (!configRestored) blockers.push('plugin-config-not-restored');
  if (!observations.every((entry) => entry.zeroWrite)) blockers.push('proxima-write-observed');

  // The lifecycle only counts where Proxima actually saw the change land.
  const created = observations.find((entry) => entry.step === 'create');
  const modified = observations.find((entry) => entry.step === 'modify');
  const deleted = observations.find((entry) => entry.step === 'delete');
  if (!created?.probePresent) blockers.push('create-not-observed');
  if (!deleted || deleted.probePresent) blockers.push('delete-not-observed');
  if (!modified) blockers.push('modify-not-observed');

  return report({ stages, observations, blockers });
}

/** Whether Obsidian's registry says this exact root is the vault it will reopen. */
async function vaultIsObsidiansOpenVault(root) {
  const registry = join(process.env.APPDATA ?? '', 'obsidian', 'obsidian.json');
  const parsed = await readJson(registry);
  const vaults = Object.values(parsed?.vaults ?? {});
  const normalise = (value) => String(value ?? '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
  const target = normalise(root);
  return vaults.some((vault) => vault?.open === true && normalise(vault.path) === target);
}

async function installProbe(probeDir) {
  await mkdir(probeDir, { recursive: true });
  for (const file of ['manifest.json', 'main.js']) {
    await copyFile(join(HERE, 'coexistence-probe', file), join(probeDir, file));
  }
}

async function enableProbe(enabledFile, backup) {
  let list = [];
  try {
    const parsed = JSON.parse(backup ?? '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  if (!list.includes(PROBE_ID)) list.push(PROBE_ID);
  await writeFile(enabledFile, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/**
 * Start Obsidian, wait until the plugin has written the step into its own data,
 * then stop it. Waiting on the plugin's record rather than a fixed delay is what
 * ties the observation to a mutation that actually happened.
 */
async function runObsidianUntilStep(obsidian, root, probeDir, step) {
  const dataFile = join(probeDir, 'data.json');
  // An unhandled 'error' event here would take the whole process down and skip the
  // finally block that restores the creator's vault — which is precisely what
  // happened the first time this ran against a launcher that did not exist.
  // Cleanup must survive a failure to start, so the failure is captured, not thrown.
  let launchFailed = null;
  // Launched with no arguments: Obsidian reopens the vault it already has open,
  // and the caller has verified that is the requested root. Passing an
  // obsidian://open URI added an encoding-and-handler variable that silently
  // produced a launch which never loaded the plugin, and no argument can be
  // misinterpreted.
  const child = spawn(obsidian, [], { detached: true, stdio: 'ignore' });
  child.once('error', (error) => { launchFailed = error; });
  child.unref();

  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let entry = null;
  while (Date.now() < deadline && !launchFailed) {
    const data = await readJson(dataFile);
    entry = (data?.log ?? []).find((item) => item.step === step) ?? null;
    if (entry) break;
    await delay(1000);
  }

  await stopObsidian();
  // Obsidian flushes plugin data on unload; re-read once it is gone.
  if (!entry) {
    const data = await readJson(dataFile);
    entry = (data?.log ?? []).find((item) => item.step === step) ?? null;
  }
  return { ok: !launchFailed && Boolean(entry) && entry.outcome === 'ok', entry, launchFailed: launchFailed ? 'launch-failed' : null };
}

/**
 * Stop Obsidian and wait until it is genuinely gone.
 *
 * A fixed pause after taskkill was not enough: the next launch landed while the
 * previous process was still shutting down and exited immediately against its own
 * singleton lock, so the second mutation never happened and the step timed out.
 * Polling for the process to disappear, then giving the lock a moment, makes the
 * relaunch deterministic.
 */
async function stopObsidian() {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/IM', 'Obsidian.exe', '/F', '/T'], { stdio: 'ignore' });
    killer.once('exit', () => resolve(undefined));
    killer.once('error', () => resolve(undefined));
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await obsidianProcessCount()) === 0) break;
    await delay(1000);
  }
  // The singleton lock outlives the process by a moment.
  await delay(5000);
}

function obsidianProcessCount() {
  return new Promise((resolve) => {
    const probe = spawn('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (chunk) => { out += String(chunk); });
    probe.once('close', () => resolve((out.match(/Obsidian\.exe/gi) || []).length));
    probe.once('error', () => resolve(0));
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function report({ stages, observations, blockers, baseline }) {
  const codes = [...new Set(blockers)].slice(0, 20);
  return {
    schemaVersion: 1,
    gate: '6R',
    status: codes.length === 0 ? 'PASS' : 'BLOCKED',
    // The precise claim, so nobody can read more into it later.
    claim: 'filesystem mutation executed by the running Obsidian process through app.vault',
    notClaimed: ['human-authored edit', 'spontaneous real-world Obsidian behaviour', 'Papers-hosted access'],
    transport: 'loopback-agent-bridge',
    papersHosted: false,
    proximaWrites: 0,
    stages,
    observations,
    blockerCodes: codes,
    baselineStatus: baseline?.status ?? 'PASS',
    open: ['native-fsa-grant', 'clean-profile-picker', 'papers-hosted-acceptance', 'write-concurrency'],
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const result = await runCoexistence({ root: value('--root'), obsidian: value('--obsidian') });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
