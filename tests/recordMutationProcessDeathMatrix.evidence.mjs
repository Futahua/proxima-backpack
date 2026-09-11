import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BEFORE_COMMIT = fileURLToPath(new URL('./recordMutationBeforeCommitProcessDeath.evidence.mjs', import.meta.url));
const AFTER_COMMIT = fileURLToPath(new URL('./recordMutationAfterCommitProcessDeath.evidence.mjs', import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runEvidenceOnce(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script], { cwd: process.cwd(), windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const signal = error?.signal;
      if (code !== 0) {
        reject(new Error(`Process-death evidence failed: script=${script} code=${String(code)} signal=${String(signal)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout).trim()));
      } catch (error) {
        reject(new Error(`Process-death evidence did not emit exactly one JSON result: script=${script} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} cause=${String(error)}`));
      }
    });
  });
}

async function runEvidence(script) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await runEvidenceOnce(script);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const beforeCommit = await runEvidence(BEFORE_COMMIT);
assert(beforeCommit.ok === true, 'Before-commit process-death evidence did not report success.');
assert(beforeCommit.boundary === 'child-process-killed-after-durable-prepared-before-checked-record-commit', 'Before-commit evidence reported the wrong crash boundary.');
assert(beforeCommit.childExited === true && beforeCommit.killIssued === true, 'Before-commit evidence did not prove real child-process death.');
assert(beforeCommit.durablePreparedSurvivedDeath === true, 'Before-commit durable prepared state did not survive process death.');
assert(beforeCommit.physicalCommitAttempted === false, 'Before-commit evidence crossed the physical record effect.');
assert(beforeCommit.startupClassification === 'not-applied' && beforeCommit.startupStatus === 'recovered' && beforeCommit.durableFinalStatus === 'recovered', 'Before-commit process death did not classify effect-absent as recovered.');

const afterCommit = await runEvidence(AFTER_COMMIT);
assert(afterCommit.ok === true, 'After-commit process-death evidence did not report success.');
assert(afterCommit.boundary === 'child-process-killed-after-checked-record-commit-before-durable-journal-finalization', 'After-commit evidence reported the wrong crash boundary.');
assert(afterCommit.childExited === true && afterCommit.killIssued === true, 'After-commit evidence did not prove real child-process death.');
assert(afterCommit.physicalCommitCompletedBeforeDeath === true && afterCommit.journalCommittedBeforeDeath === false && afterCommit.durablePreparedSurvivedDeath === true, 'After-commit evidence did not preserve the intended crash window.');
assert(afterCommit.startupClassification === 'effect-present' && afterCommit.startupStatus === 'committed' && afterCommit.durableFinalStatus === 'committed', 'After-commit process death did not classify effect-present as committed.');
assert(afterCommit.rollbackOccurred === false, 'After-commit recovery rolled back the committed effect.');

const classifications = [`${beforeCommit.startupClassification}->${beforeCommit.startupStatus}`, `${afterCommit.startupClassification}->${afterCommit.startupStatus}`];
assert(classifications[0] === 'not-applied->recovered' && classifications[1] === 'effect-present->committed', 'Process-death recovery matrix is incomplete.');

console.log(JSON.stringify({
  ok: true,
  evidence: 'record-process-death-recovery-classification-matrix',
  cases: [
    { boundary: 'before-commit', classification: beforeCommit.startupClassification, status: beforeCommit.startupStatus, durableFinalStatus: beforeCommit.durableFinalStatus },
    { boundary: 'after-commit-before-journal-finalization', classification: afterCommit.startupClassification, status: afterCommit.startupStatus, durableFinalStatus: afterCommit.durableFinalStatus },
  ],
  classifications,
  complete: true,
}, null, 2));
