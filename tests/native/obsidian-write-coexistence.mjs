import { execFileSync } from 'node:child_process';

const MAX_DIAGNOSTIC = 240;
function bounded(value) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC); }
function open(reason, detail = '') {
  process.stdout.write(`${JSON.stringify({ status: 'OPEN', reason, detail: bounded(detail), creatorVaultTouched: false })}\n`);
  process.exitCode = 0;
}

let versionOutput = '';
try {
  versionOutput = execFileSync('obsidian', ['version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  versionOutput = `${error?.stdout ?? ''} ${error?.stderr ?? ''}`;
}
if (!versionOutput || /out of date|better CLI support|not found|is not recognized/i.test(versionOutput)) {
  open('obsidian-cli-unavailable', versionOutput || 'obsidian command unavailable');
} else if (!process.env.PROXIMA_OBSIDIAN_ACCEPTANCE_VAULT) {
  open('dedicated-acceptance-vault-unavailable', 'PROXIMA_OBSIDIAN_ACCEPTANCE_VAULT is not configured');
} else {
  // The actual CLI mutation matrix is intentionally opt-in and remains outside
  // the normal test suite. Refuse to infer a creator vault from ambient state.
  open('native-harness-not-enabled', 'dedicated disposable CLI protocol is not configured');
}
