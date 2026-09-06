import { mkdir, rm, writeFile } from 'node:fs/promises';

// This path is intentionally fixed to the disposable clean-profile fixture. It must
// never be pointed at a creator vault or inferred from a user-selected path.
export const CLEAN_FIXTURE_ROOT = 'C:/This is Minh/MatTroiSeConMoc/gate5-fsa-clean-fixture';

export async function resetCleanFixture() {
  await rm(CLEAN_FIXTURE_ROOT, { recursive: true, force: true });
  await mkdir(`${CLEAN_FIXTURE_ROOT}/nested`, { recursive: true });
  await writeFile(`${CLEAN_FIXTURE_ROOT}/README.md`, 'Gate 5 disposable FSA fixture\n\nThis folder is disposable test data for the Papers File System Access spike. It is\nnot a creator vault and must not be used for product data.\n', 'utf8');
  await writeFile(`${CLEAN_FIXTURE_ROOT}/root-note.txt`, 'clean-profile-root-v1\n', 'utf8');
  await writeFile(`${CLEAN_FIXTURE_ROOT}/nested/child-note.txt`, 'gate5-child-v1\n', 'utf8');
  return { fixtureRoot: CLEAN_FIXTURE_ROOT, files: ['README.md', 'root-note.txt', 'nested/child-note.txt'] };
}

if (process.argv[1]?.endsWith('reset-gate5-clean-fixture.mjs')) console.log(JSON.stringify(await resetCleanFixture()));
