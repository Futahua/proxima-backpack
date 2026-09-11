import {
  spawn,
} from 'node:child_process';
import {
  open,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import {
  dirname,
  join,
} from 'node:path';
import {
  fileURLToPath,
} from 'node:url';
import {
  tmpdir,
} from 'node:os';

const RECORD_FILE =
  'pxr_00000000000000000000000000000001.json';
const REQUEST_ID =
  'process-death-before-commit';
const PREPARED_MARKER =
  'PROXIMA_PREPARED_DURABLE_BEFORE_COMMIT';
const CHILD_FLAG =
  '--before-commit-child';
const FIXED_TIME =
  Date.parse(
    '2026-09-11T07:00:00.000Z',
  );

function recordStatePath(root) {
  return join(root, 'record-state.json');
}
function journalPath(root) {
  return join(root, 'recovery-journal.json');
}
function commitAttemptPath(root) {
  return join(root, 'physical-commit-attempted.txt');
}

async function writeSynced(target, value) {
  const handle = await open(target, 'w');
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function optionalText(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readRecordState(root) {
  const raw = await readFile(recordStatePath(root), 'utf8');
  return JSON.parse(raw);
}

async function writeRecordState(root, state) {
  await writeSynced(
    recordStatePath(root),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function createDiskRecordBackend(root) {
  return {
    async listRecordFiles() {
      const state = await readRecordState(root);
      return [state.fileName];
    },
    async readRecordFile(fileName) {
      const state = await readRecordState(root);
      if (fileName !== state.fileName) return undefined;
      return { text: state.text, revision: state.revision };
    },
    async createRecordFile(fileName, text) {
      const state = await readRecordState(root);
      if (fileName === state.fileName) {
        return { ok: false, reason: 'already-exists', actualRevision: state.revision };
      }
      await writeSynced(commitAttemptPath(root), 'create\n');
      return { ok: false, reason: 'storage-failure' };
    },
    async writeRecordFileIfUnchanged(fileName, text, expectedRevision) {
      await writeSynced(commitAttemptPath(root), 'update\n');
      const state = await readRecordState(root);
      if (fileName !== state.fileName) return { ok: false, reason: 'missing' };
      if (state.revision !== expectedRevision) {
        return { ok: false, reason: 'stale', actualRevision: state.revision };
      }
      await writeRecordState(root, { fileName, text, revision: 'record-r2' });
      return { ok: true, revision: 'record-r2' };
    },
    async deleteRecordFileIfUnchanged(fileName, expectedRevision) {
      await writeSynced(commitAttemptPath(root), 'delete\n');
      const state = await readRecordState(root);
      if (fileName !== state.fileName) return { ok: false, reason: 'missing' };
      if (state.revision !== expectedRevision) {
        return { ok: false, reason: 'stale', actualRevision: state.revision };
      }
      return { ok: false, reason: 'storage-failure' };
    },
  };
}

function createDiskRecoveryJournalBackend(root, { pauseAfterDurableWrite = false } = {}) {
  return {
    async read() {
      return optionalText(journalPath(root));
    },
    async write(value) {
      await writeSynced(journalPath(root), value);
      if (pauseAfterDurableWrite) {
        process.stdout.write(`${PREPARED_MARKER}\n`);
        await new Promise(() => {});
      }
    },
  };
}

async function loadProductionModules() {
  const mutation = await import(new URL('../public/build/app/recordMutation.js', import.meta.url).href);
  const recovery = await import(new URL('../public/build/app/vaultRecovery.js', import.meta.url).href);
  const startup = await import(new URL('../public/build/app/recordRecoveryStartup.js', import.meta.url).href);
  return {
    createRecordMutationCoordinator: mutation.createRecordMutationCoordinator,
    createDurableRecoveryStore: recovery.createDurableRecoveryStore,
    startRecordMutationAuthority: startup.startRecordMutationAuthority,
  };
}

async function runChild(root) {
  const { createRecordMutationCoordinator, createDurableRecoveryStore } = await loadProductionModules();
  const backend = createDiskRecordBackend(root);
  const recovery = createDurableRecoveryStore(
    createDiskRecoveryJournalBackend(root, { pauseAfterDurableWrite: true }),
  );
  const coordinator = createRecordMutationCoordinator({
    backend,
    recovery,
    clock: { now() { return FIXED_TIME; } },
  });
  await coordinator.execute({
    kind: 'update',
    fileName: RECORD_FILE,
    text: 'new',
    expectedRevision: 'record-r1',
    requestId: REQUEST_ID,
  });
  throw new Error('Before-commit process-death barrier unexpectedly returned.');
}

function waitForPreparedMarker(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for durable prepared marker. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(PREPARED_MARKER)) {
        clearTimeout(timer);
        resolve({ stdout, stderr });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => {
      if (!stdout.includes(PREPARED_MARKER)) {
        clearTimeout(timer);
        reject(new Error(`Child exited before durable prepared marker: code=${String(code)} signal=${String(signal)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function parseJournal(root) {
  const raw = await readFile(journalPath(root), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Recovery journal was not an array.');
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runParent() {
  const root = await mkdtemp(join(tmpdir(), 'proxima-before-commit-death-'));
  let child;
  try {
    await writeRecordState(root, { fileName: RECORD_FILE, text: 'old', revision: 'record-r1' });
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), CHILD_FLAG, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const childPid = child.pid;
    assert(typeof childPid === 'number', 'Child process did not receive a PID.');
    await waitForPreparedMarker(child);
    const preparedJournal = await parseJournal(root);
    assert(preparedJournal.length === 1, 'Expected exactly one durable recovery record before process death.');
    assert(preparedJournal[0]?.requestId === REQUEST_ID, 'Unexpected durable recovery request before process death.');
    assert(preparedJournal[0]?.status === 'prepared', 'Recovery record was not durably prepared before process death.');
    assert(preparedJournal[0]?.path === RECORD_FILE, 'Prepared recovery target changed.');
    const stateBeforeKill = await readRecordState(root);
    assert(stateBeforeKill.text === 'old', 'Record bytes changed before process death.');
    assert(stateBeforeKill.revision === 'record-r1', 'Record revision changed before process death.');
    assert((await optionalText(commitAttemptPath(root))) === undefined, 'Checked physical record commit was entered before process death.');
    const killIssued = child.kill('SIGKILL');
    assert(killIssued, 'Failed to issue process-death signal.');
    const childExit = await waitForExit(child);
    child = undefined;
    assert(childExit.code !== 0, 'Injected child process unexpectedly exited successfully.');
    const journalAfterDeath = await parseJournal(root);
    assert(journalAfterDeath[0]?.status === 'prepared', 'Durable prepared state did not survive process death.');
    const stateAfterDeath = await readRecordState(root);
    assert(stateAfterDeath.text === 'old', 'Record bytes changed across the before-commit process death.');
    assert(stateAfterDeath.revision === 'record-r1', 'Record revision changed across the before-commit process death.');
    assert((await optionalText(commitAttemptPath(root))) === undefined, 'Physical record commit was attempted despite before-commit process death.');

    const { createDurableRecoveryStore, startRecordMutationAuthority } = await loadProductionModules();
    const recovery = createDurableRecoveryStore(createDiskRecoveryJournalBackend(root));
    const startup = await startRecordMutationAuthority({ backend: createDiskRecordBackend(root), recovery });
    assert(startup.mutationAuthority === 'available', 'Effect-absent before-commit recovery did not restore mutation authority.');
    assert(startup.unresolved === 1, 'Expected one unresolved prepared recovery record at startup.');
    assert(startup.outcomes.length === 1, 'Expected one startup recovery outcome.');
    assert(startup.outcomes[0]?.requestId === REQUEST_ID, 'Startup reconciled the wrong recovery request.');
    assert(startup.outcomes[0]?.classification === 'not-applied', 'Before-commit process death did not classify as not-applied.');
    assert(startup.outcomes[0]?.status === 'recovered', 'Before-commit process death did not persist recovered status.');
    const finalRecords = recovery.list();
    assert(finalRecords.length === 1, 'Expected exactly one reconciled recovery record.');
    assert(finalRecords[0]?.status === 'recovered', 'Durable recovery record did not finish as recovered.');
    assert((await optionalText(commitAttemptPath(root))) === undefined, 'Startup reconciliation attempted a physical record commit.');
    const finalState = await readRecordState(root);
    assert(finalState.text === 'old' && finalState.revision === 'record-r1', 'Startup reconciliation changed record state.');
    console.log(JSON.stringify({
      ok: true,
      boundary: 'child-process-killed-after-durable-prepared-before-checked-record-commit',
      childPid,
      childExited: true,
      killIssued: true,
      exitCode: childExit.code,
      exitSignal: childExit.signal,
      durablePreparedBeforeDeath: true,
      durablePreparedSurvivedDeath: true,
      physicalCommitAttempted: false,
      recordTextAfterDeath: finalState.text,
      recordRevisionAfterDeath: finalState.revision,
      startupMutationAuthority: startup.mutationAuthority,
      startupClassification: startup.outcomes[0]?.classification,
      startupStatus: startup.outcomes[0]?.status,
      durableFinalStatus: finalRecords[0]?.status,
    }, null, 2));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === CHILD_FLAG) {
  const root = process.argv[3];
  if (!root) throw new Error('Missing before-commit process-death fixture root.');
  await runChild(root);
} else {
  await runParent();
}
