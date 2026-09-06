# Proxima Backpack

Proxima as an independent project: an Elastic board, a calendar and projects, over
the creator's ordinary Obsidian vault files.

This is the successor to the `Proxima-Obsidian` plugin. It is not a port of that
codebase and not a replication of it. The plugin's defect was structural — its logic
bent to whatever the Obsidian API happened to support, and grew messy doing so. Here,
Proxima owns its own domain model and reads the same files from the outside.

## What this is not

- Not part of Papers' compiled binaries. Papers hosts it; Papers does not know what a
  project, task, event or vault is.
- Not an Obsidian plugin, and not an emulation of one. There is no fake `App`, `Vault`
  or `WorkspaceLeaf` compatibility layer — building one would preserve exactly the
  architecture this project exists to leave.
- Not a writer, yet. See below.

## Relationship to Obsidian

Obsidian is a peer, not a host. The vault stays canonical on disk and stays fully
editable in Obsidian, with its plugins — Excalidraw in particular — working exactly as
they do today.

**Proxima does not write to the vault in v1.** Obsidian is the only writer. Two
programs editing the same Markdown file need a specified conflict model before either
is allowed to save, and that model does not exist yet. Read-only first is a decision
about protecting real creator data, not a limitation to route around.

## Data layout

One Markdown file per record, under a configurable root (default `Proxima`):

```
<root>/projects/{id}.md      or  <root>/projects/{id}/index.md
<root>/tasks/{id}.md
<root>/events/{id}.md
```

The plugin's own default — `-Hide/Proxima/projects | tasks | events` — is read too, in
place, with no migration and no writes. Each of the three directories is configured
separately, so a vault someone rearranged by hand stays readable.

Each file carries frontmatter Proxima interprets and a body it leaves alone. A record's
logical id is what it declares in `id:`, or failing that its own filename — never its
path, so moving a file does not silently create a different record. Every record keeps a
reference back to the file, revision and rule that produced it, and two records claiming
the same id is a reported error rather than a tiebreak.

The frontmatter parser handles a documented subset — scalars, quoted strings, inline and
block lists — which is why the fixtures are real files rather than assumed YAML.

## Fixture browser build

`npm run build` emits a self-contained static page at `public/index.html` and browser
modules under `public/build/`. The page boots the real `vault-basic` fixture through the
memory adapter and vault reader, with no FSA picker, Obsidian runtime, network request,
or real-vault write authority. The page exposes the exact git SHA, fixture hash,
lockfile hash, schema versions, fixed clock, hydration revision and record/problem
counts so an acceptance run can identify exactly what it loaded.

**`docs/VAULT-FORMATS.md`** is the full specification: both layouts, the discovery
rules, identity semantics and every problem code. **`docs/DECISIONS.md`** records the
choices behind them, and **`docs/AUDIT-CHECKLIST.md`** is the project agenda and the
contract each pushed commit is audited against.

## The Elastic board

Three columns: Backlog, Running, Finished. Column membership is always derived from a
task's status and completion, never stored, so a task cannot disagree with the column
it is drawn in.

What makes the board Elastic: running cards are sized by *time*, not by list order.
Fixed-duration tasks are carved out of the remaining window first; everything else
divides what is left in proportion to its weight, capped by `maxDuration`. Move the
deadline and every card resizes.

## Layout

```
src/domain/      pure model — no host, no filesystem, no framework
src/ports/       the seam that replaces Obsidian's App/Vault
src/adapters/    implementations of that seam
src/app/         layout, discovery, and reading Proxima state out of vault files
fixtures/        real vault files, used by tests and by the page
docs/            formats, decisions and the audit checklist
public/          the static build Papers serves
```

The dependency rule is one-directional: `domain` imports nothing outside itself. That
is enforced, not just documented — `tests/boundaries.test.ts` fails on a host,
framework or filesystem import in the domain, and `src/` typechecks with no ambient
Node types, so `node:fs` cannot compile there at all.

## Running it

```bash
npm install
npm test        # vitest, over the real fixture vaults
npm run typecheck
npm run build
```

## Agent-controlled read-only bridge

The browser can be bootstrapped without a native folder-picker gesture by using the
loopback bridge. Start it with the explicit creator-vault root, then open the generated
page with `?bridge=`:

```bash
npm run agent:bridge -- --root "D:\\Vaults\\Creator" --port 4174
# open http://127.0.0.1:4173/?bridge=http://127.0.0.1:4174
```

The bridge binds only to loopback, accepts only bounded `GET`/`OPTIONS` requests, and
exposes list/read/exists/walk data. It never writes, migrates, watches, invokes Papers,
or replaces the native grant boundary. The root is intentionally explicit; Proxima does
not crawl the machine or guess which directory is a creator vault.

## Papers binding

The acceptance machine has a real Papers Backpack identity and a machine-local
`PapersData/backpack-projects.json` entry mapping that id to this folder. The matching
`project.json` carries `schemaVersion`, the local `backpackId` and a `public/` entry.
The UUID is intentionally not a portable product identity; another machine must mint
and bind its own Backpack rather than copying this registration state.

The browser surface is fixture-only and read-only. Its project-owned action dispatcher
and inspection projection live in `src/app/actionProtocol.ts` and
`src/app/inspection.ts`; Papers remains an opaque host and does not interpret these
contracts.

## Status

Early. The domain layer, vault seam, fixture vaults, deterministic browser surface,
semantic action dispatcher, inspection projection and test suite exist. Both the
preferred and legacy vault layouts load; real-vault writes remain disabled.

Progress is tracked gate by gate in `docs/AUDIT-CHECKLIST.md`.
