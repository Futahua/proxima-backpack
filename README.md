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
<root>/projects/*.md
<root>/tasks/*.md
<root>/events/*.md
```

Each file carries frontmatter Proxima interprets and a body it leaves alone. A file
with no `id` is identified by its path, so nothing has to be rewritten to be readable.
The frontmatter parser handles a documented subset — scalars, quoted strings, inline
and block lists — which is why the fixtures are real files rather than assumed YAML.

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
src/app/         reads Proxima state out of vault files
fixtures/        real vault files, used by tests and by the page
public/          the static build Papers serves
```

The dependency rule is one-directional: `domain` imports nothing outside itself.

## Running it

```bash
npm install
npm test
npm run build
```

## Papers binding

Not bound yet. Papers mints a Backpack identity (`bp-<uuid>`) in the app, and a
machine-local `PapersData/backpack-projects.json` entry maps that id to this folder.
`project.json` — carrying `schemaVersion`, the matching `backpackId` and a `public/`
entry — is deliberately absent until a real Backpack identity exists, rather than
committed with a placeholder id that would silently fail to match.

## Status

Early. The domain layer, the vault seam, the fixture vault and the test suite exist.
The screen does not run yet.
