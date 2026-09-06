import { mkdir, rm, writeFile } from 'node:fs/promises';

// This path is intentionally fixed to the disposable clean-profile fixture. It must
// never be pointed at a creator vault or inferred from a user-selected path.
const fixtureRoot = 'C:/This is Minh/MatTroiSeConMoc/gate5-fsa-clean-fixture';

await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(`${fixtureRoot}/nested`, { recursive: true });
await writeFile(`${fixtureRoot}/README.md`, 'Gate 5 disposable FSA fixture\n\nThis folder is disposable test data for the Papers File System Access spike. It is\nnot a creator vault and must not be used for product data.\n', 'utf8');
await writeFile(`${fixtureRoot}/root-note.txt`, 'clean-profile-root-v1\n', 'utf8');
await writeFile(`${fixtureRoot}/nested/child-note.txt`, 'gate5-child-v1\n', 'utf8');
console.log(JSON.stringify({ fixtureRoot, files: ['README.md', 'root-note.txt', 'nested/child-note.txt'] }));
