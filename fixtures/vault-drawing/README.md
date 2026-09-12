# vault-drawing

Two drawings, in the Obsidian envelope the creator's own vault uses, so the Excalidraw display path can
be driven *from a fixture vault* rather than from a payload written inline in a test - the Gate 11
scenario box asked for exactly that, and a fixture is what a scenario runner can be pointed at.

- `Mood board.excalidraw.md` - the plain `json` fence, carrying the element vocabulary the renderer
  supports (`freedraw`, `text`, `line`, `arrow`). It must render **completely**: four elements, four
  drawn, nothing unsupported, nothing reported.
- `Compressed sketch.excalidraw.md` - the `compressed-json` fence the plugin actually writes, carrying a
  genuinely compressed payload. It must decode, and the one element outside the supported vocabulary has
  to be **reported** by the renderer rather than dropped.

Both are asserted in `tests/excalidrawFixture.test.ts`, together with the boundary they live on: they sit
in `Proxima/drawings/`, which is not a record directory, so loading this vault as a record source finds
no records **and reports no problems** - a drawing beside the record directories costs nothing.

Two rules for anyone adding fixture bytes here:

1. **No wikilink syntax.** Fixture contents are compiled into
   `src/browser/generated/fixtureVault.generated.ts` and therefore ship into the browser layer, and
   `tests/boundaries.test.ts` keeps `[[...]]` out of that layer except in the one module that decodes a
   raw asset embed. An `## Embedded Files` line in a fixture fails that boundary - which is how this
   fixture learned it.
2. **The compressed payload is not hand-written.** It is the same LZ-String payload the suite already
   carries, produced by the upstream compressor; a synthetic "looks compressed" string would prove
   nothing about the algorithm.
