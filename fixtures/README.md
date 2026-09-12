# Fixtures

Real files, not mocks: each directory here is a vault the reader discovers the way it discovers a
creator's, and `tests/fixtures.ts` loads them off disk as the bytes they hold. Two rules matter when you
add or change one.

## Nothing inside a vault directory is private

Every file under a vault directory is compiled into `src/browser/generated/fixtureVault.generated.ts` and
therefore ships into the browser layer, comments included. That has two consequences.

**Keep double-bracket link syntax out of fixture bytes.** `tests/boundaries.test.ts` keeps it out of the
browser layer everywhere except the one module that decodes a raw asset embed, and a fixture carrying it
fails that check - which is how `vault-drawing` learned the rule when its first version carried an
`## Embedded Files` line, and again when a README inside the vault directory explained the rule in the
syntax it was warning about. Notes about a fixture belong here, beside the vaults rather than inside one.

**Assume the bytes are read by a test that hashes them.** Moving or reformatting a fixture file changes
what the evidence says, so change one deliberately and let the suites that read it say so.

## The vaults

| Vault | What it is for |
| --- | --- |
| `vault-basic` | The preferred layout: tasks, projects and events as a creator would write them. |
| `vault-legacy` | The legacy layout, including a `-Hide` tree, so discovery has both to choose between. |
| `vault-malformed` | Unsupported frontmatter and fields that cannot be read, so the reported codes have real bytes behind them. |
| `vault-duplicates` | Two records resolving to one logical id, which is a reported error and never a tiebreak. |
| `vault-drawing` | Two Excalidraw drawings - one plain `json` fence, one `compressed-json` - so the display scenario runs from fixture bytes rather than from a literal in a test. |

For `vault-drawing` specifically, the two fences are asserted in `tests/excalidrawFixture.test.ts`: the
plain one must render **completely** in the renderer's supported vocabulary (`freedraw`, `text`, `line`,
`arrow`), the compressed one must decode with its one out-of-vocabulary element **reported** rather than
dropped, and neither is a record or a problem to the record source because `Proxima/drawings/` is not a
record directory. Its compressed payload is the upstream-compressed one the suite already carried, never
a hand-written lookalike.
