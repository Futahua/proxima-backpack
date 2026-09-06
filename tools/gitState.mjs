/**
 * Git provenance for the build identity.
 *
 * A build identity exists so a piece of evidence can name the code that produced it.
 * `git rev-parse HEAD` alone cannot do that: it answers "what was the last commit",
 * not "what did you build". Build from a modified working tree and it reports a clean
 * commit hash for bytes that commit does not contain — and since the audit protocol
 * is "here is the exact pushed SHA", that turns the identity into a confident lie.
 *
 * Untracked files count as dirty. `fixtures/` is bundled into the page wholesale, so
 * an uncommitted fixture file genuinely changes the build.
 *
 * Also usable as a CLI so it can be tested against a throwaway repository:
 *   node tools/gitState.mjs [dir]   ->   JSON on stdout
 */
import { execFileSync } from 'node:child_process';

/**
 * @param {string} cwd
 * @returns {{ sha: string, treeState: 'clean' | 'dirty' | 'unknown', dirtyFileCount: number, describe: string }}
 */
export function readGitState(cwd) {
  const git = (args) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

  try {
    const sha = git(['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return unknownState();

    const dirtyFileCount = git(['status', '--porcelain'])
      .split('\n')
      .filter((line) => line.trim() !== '').length;
    const treeState = dirtyFileCount > 0 ? 'dirty' : 'clean';

    return {
      sha,
      treeState,
      dirtyFileCount,
      // The quotable form. Someone copying provenance into an audit note cannot
      // accidentally quote a clean SHA for a dirty build.
      describe: treeState === 'dirty' ? `${sha}-dirty` : sha,
    };
  } catch {
    // No git, or not a repository — a tarball export, for instance. Say so rather
    // than failing the build or inventing a hash.
    return unknownState();
  }
}

function unknownState() {
  return { sha: 'unknown', treeState: /** @type {const} */ ('unknown'), dirtyFileCount: 0, describe: 'unknown' };
}

if (process.argv[1]?.endsWith('gitState.mjs')) {
  process.stdout.write(JSON.stringify(readGitState(process.argv[2] ?? process.cwd())));
}
