import { appendFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, operation, phase] = process.argv.slice(2);
const path = join(root, 'task.md');
const destination = join(root, 'moved.md');
const prior = Buffer.from('original');
const next = Buffer.from('proxima');
const record = { requestId: `crash-${operation}-${phase}`, operation, path: 'task.md', ...(operation === 'move' ? { destination: 'moved.md' } : {}), revision: 'task.md@1', bytes: [...prior], ...(operation === 'update' ? { nextBytes: [...next] } : {}), createdAt: '2026-09-08T00:00:00.000Z', status: phase === 'after-mark' ? 'committed' : 'prepared' };
writeFileSync(join(root, 'recovery.json'), JSON.stringify([record]), 'utf8');
if (phase === 'after-commit' || phase === 'after-mark') {
  if (operation === 'update') writeFileSync(path, next);
  if (operation === 'delete') unlinkSync(path);
  if (operation === 'move') renameSync(path, destination);
}
appendFileSync(join(root, 'worker.done'), 'done');
