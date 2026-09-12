/**
 * Source text for a whole-file assertion, with the checkout's line endings normalized.
 *
 * Suites here read a source file and assert that a literal appears in it. A literal that spans lines
 * is written with `\n`, so a checkout that handed the reader CRLF would fail an assertion that is
 * about the *code* rather than about the checkout - and this machine has `core.autocrlf=true` while
 * the repository carries no `.gitattributes`, so a fresh Windows clone really does get CRLF. Exactly
 * one assertion in the tree was exposed to that (`recordMutationContainment.test.ts`'s three-line
 * import check), which is why this is a helper and a test rather than a repository-wide policy: the
 * policy is a decision with 133 files of churn attached and belongs to the creator, while an
 * assertion that means "this import line" should not depend on it either way.
 *
 * Byte-level work must not use this: the import-staging and writer suites compare real bytes, and
 * normalizing there would erase the thing they are checking.
 */
import { readFile } from 'node:fs/promises';

/** Read a source file as text with CRLF collapsed to LF. */
export async function sourceText(url: URL): Promise<string> {
  const text = await readFile(url, 'utf8');
  return text.replace(/\r\n/g, '\n');
}

/**
 * The same reading applied to text a test already holds.
 *
 * Exported so a case can prove the normalization on a CRLF copy of real source without needing a
 * second checkout on disk.
 */
export function normalizedSource(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
