import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const RECORD_FILE = 'pxr_00000000000000000000000000000001.json';
const REQUEST_ID = 'process-death-after-commit-before-journal-finalization';
const MARKER = 'PROXIMA_PHYSICAL_COMMIT_DURABLE_BEFORE_JOURNAL_FINALIZATION';
const CHILD_FLAG = '--after-commit-child';
const FIXED_TIME = Date.parse('2026-09-11T08:00:00.000Z');

const pathOf = (root, name) => join(root, name);
async function writeSynced(target, value) {
  const handle = await open(target, 'w');
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function readJson(target) { return JSON.parse(await readFile(target, 'utf8')); }
async function optionalText(target) {
  try { return await readFile(target, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}
async function writeState(root, state) { await writeSynced(pathOf(root, 'record-state.json'), `${JSON.stringify(state, null, 2)}\n`); }
function recordBackend(root) {
  return {
    async listRecordFiles() { return [(await readJson(pathOf(root, 'record-state.json'))).fileName]; },
    async readRecordFile(fileName) {
      const state = await readJson(pathOf(root, 'record-state.json'));
      return fileName === state.fileName ? { text: state.text, revision: state.revision } : undefined;
    },
    async createRecordFile() { throw new Error('unexpected create'); },
    async writeRecordFileIfUnchanged(fileName, text, expectedRevision) {
      const state = await readJson(pathOf(root, 'record-state.json'));
      if (fileName !== state.fileName) return { ok: false, reason: 'missing' };
      if (state.revision !== expectedRevision) return { ok: false, reason: 'stale', actualRevision: state.revision };
      await writeState(root, { fileName, text, revision: 'record-r2' });
      await writeSynced(pathOf(root, 'physical-commit-completed.txt'), 'update record-r2\n');
      return { ok: true, revision: 'record-r2' };
    },
    async deleteRecordFileIfUnchanged() { throw new Error('unexpected delete'); },
  };
}
function recoveryBackend(root, pauseFinalization = false) {
  let writes = 0;
  return {
    async read() { return optionalText(pathOf(root, 'recovery-journal.json')); },
    async write(value) {
      writes += 1;
      if (pauseFinalization && writes === 2) {
        const state = await readJson(pathOf(root, 'record-state.json'));
        const marker = await optionalText(pathOf(root, 'physical-commit-completed.txt'));
        const journal = await readJson(pathOf(root, 'recovery-journal.json'));
        if (state.text !== 'new' || state.revision !== 'record-r2' || !marker || journal[0]?.status !== 'prepared') throw new Error('after-commit barrier preconditions failed');
        process.stdout.write(`${MARKER}\n`);
        await new Promise(() => {});
      }
      await writeSynced(pathOf(root, 'recovery-journal.json'), value);
    },
  };
}
async function modules() {
  const mutation = await import(new URL('../public/build/app/recordMutation.js', import.meta.url).href);
  const recovery = await import(new URL('../public/build/app/vaultRecovery.js', import.meta.url).href);
  const startup = await import(new URL('../public/build/app/recordRecoveryStartup.js', import.meta.url).href);
  return { ...mutation, ...recovery, ...startup };
}
async function child(root) {
  const { createRecordMutationCoordinator, createDurableRecoveryStore } = await modules();
  const coordinator = createRecordMutationCoordinator({
    backend: recordBackend(root),
    recovery: createDurableRecoveryStore(recoveryBackend(root, true)),
    clock: { now: () => FIXED_TIME },
  });
  await coordinator.execute({ kind: 'update', fileName: RECORD_FILE, text: 'new', expectedRevision: 'record-r1', requestId: REQUEST_ID });
  throw new Error('after-commit barrier unexpectedly returned');
}
function waitMarker(proc) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for marker: ${out} ${err}`)), 10000);
    proc.stdout.on('data', chunk => { out += chunk; if (out.includes(MARKER)) { clearTimeout(timer); resolve(); } });
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.once('exit', (code, signal) => { if (!out.includes(MARKER)) { clearTimeout(timer); reject(new Error(`child exited before marker: ${code}/${signal} ${out} ${err}`)); } });
  });
}
function waitExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function parent() {
  const root = await mkdtemp(join(tmpdir(), 'proxima-after-commit-death-'));
  let proc;
  try {
    await writeState(root, { fileName: RECORD_FILE, text: 'old', revision: 'record-r1' });
    proc = spawn(process.execPath, [fileURLToPath(import.meta.url), CHILD_FLAG, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const childPid = proc.pid;
    assert(typeof childPid === 'number', 'child process did not receive a PID');
    await waitMarker(proc);
    const before = await readJson(pathOf(root, 'recovery-journal.json'));
    assert(before[0]?.status === 'prepared', 'journal was not prepared at barrier');
    const state = await readJson(pathOf(root, 'record-state.json'));
    assert(state.text === 'new' && state.revision === 'record-r2', 'physical effect was not durable at barrier');
    assert(await optionalText(pathOf(root, 'physical-commit-completed.txt')), 'physical completion marker missing');
    const killIssued = proc.kill('SIGKILL');
    const exit = await waitExit(proc); proc = undefined;
    assert(killIssued && exit.code !== 0, 'child process did not die unsuccessfully');
    const afterJournal = await readJson(pathOf(root, 'recovery-journal.json'));
    assert(afterJournal[0]?.status === 'prepared', 'journal finalization reached disk before process death');
    const afterState = await readJson(pathOf(root, 'record-state.json'));
    assert(afterState.text === 'new' && afterState.revision === 'record-r2', 'record rolled back after process death');
    const { createDurableRecoveryStore, startRecordMutationAuthority } = await modules();
    const recovery = createDurableRecoveryStore(recoveryBackend(root));
    const startup = await startRecordMutationAuthority({ backend: recordBackend(root), recovery });
    assert(startup.mutationAuthority === 'available', 'startup authority remained blocked');
    assert(startup.outcomes[0]?.classification === 'effect-present' && startup.outcomes[0]?.status === 'committed', 'effect-present was not committed');
    assert(recovery.list()[0]?.status === 'committed', 'durable journal did not become committed');
    const finalState = await readJson(pathOf(root, 'record-state.json'));
    console.log(JSON.stringify({ ok: true, boundary: 'child-process-killed-after-checked-record-commit-before-durable-journal-finalization', childPid, childExited: true, killIssued: true, durablePreparedBeforeDeath: true, physicalCommitCompletedBeforeDeath: true, journalCommittedBeforeDeath: false, durablePreparedSurvivedDeath: true, recordTextAfterDeath: finalState.text, recordRevisionAfterDeath: finalState.revision, startupMutationAuthority: startup.mutationAuthority, startupClassification: startup.outcomes[0]?.classification, startupStatus: startup.outcomes[0]?.status, durableFinalStatus: recovery.list()[0]?.status, rollbackOccurred: false }, null, 2));
  } finally {
    if (proc && proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await waitExit(proc); }
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === CHILD_FLAG) await child(process.argv[3]); else await parent();
