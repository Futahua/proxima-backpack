# Proxima Backpack

Proxima is a standalone product: an Elastic board, Schedule and projects backed by
Proxima-owned canonical records.

This is the successor to the `Proxima-Obsidian` plugin. It is not a port of that
codebase and not a replication of it. The plugin's defect was structural — its logic
bent to whatever the Obsidian API happened to support, and grew messy doing so. Here,
Proxima owns both the domain model and the record store. It does not import, migrate,
or reuse Obsidian, Papers, legacy-vault, fixture, or other prior-source data.

## What this is not

- Not part of Papers' compiled binaries. Papers hosts it; Papers does not know what a
  project, task, event or vault is.
- Not an Obsidian plugin, and not an emulation of one. There is no fake `App`, `Vault`
  or `WorkspaceLeaf` compatibility layer — building one would preserve exactly the
  architecture this project exists to leave.
- Not a creator-vault writer. The repository contains conditional mutation machinery
  for memory and disposable roots, but creator-vault write authority is disabled. See
  below.

## Record ownership

The browser boots from Proxima's own OPFS record store. A brand-new store is a valid
empty workspace; there is no activation marker, migration cutover, vault fallback, or
restored external handle in the shipping path. Schedule events, recurrence series, and
occurrence overrides are canonical Proxima records.

## Data layout

Canonical records are opaque JSON files owned by Proxima's record-store boundary. The
store exposes validated list/read/create/update/delete operations and revision-checked
writes; it is not a view over Markdown paths. Historical Markdown readers and fixtures
remain isolated test or compatibility code and are not reachable from the shipping boot.

## Browser build and source modes

`npm run build` emits a self-contained static page at `public/index.html` and browser
modules under `public/build/`. The page starts with an empty or previously saved
Proxima-owned record store; it does not enumerate or load any other data source.

The page exposes build identity, schema versions, hydration revision, and record/problem
counts for diagnostics. Fixture files remain test-only historical inputs and are not part
of the browser build or startup.

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
src/ports/       storage seams, including the canonical record store
src/adapters/    implementations of that seam
src/app/         canonical records, Schedule projections and application behavior
fixtures/        historical test-only inputs, not shipped startup data
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
npm test        # vitest, including isolated historical parser fixtures
npm run typecheck
npm run build
```

## Historical bridge tooling

The loopback bridge remains available to legacy acceptance tools, but it is not a
startup source for the standalone browser and cannot import data into Proxima:

```powershell
npm run agent:bridge -- --root "D:\\Vaults\\Creator" --port 4174
npm run agent:accept -- --port 4174
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

The browser surface reads and writes only Proxima's canonical record store. The native
FSA and bridge controls are compatibility/acceptance tooling and are not alternate
startup sources.

Its project-owned action dispatcher and inspection projection live in
`src/app/actionProtocol.ts` and `src/app/inspection.ts`; Papers remains an opaque host
and does not interpret these contracts.

## Status

The domain, Board/Schedule/Canvas surfaces, canonical record-store projection, semantic
action and inspection seams, conditional mutation coordinator, durable recovery machinery,
and task/project/event mutation surfaces exist. Schedule includes Day, 4-Day, Week, Month,
Year and Agenda views, timed create/move/resize, and occurrence-versus-series recurrence.

Creator-vault writes remain disabled. Native FSA write authority is explicitly `BLOCKED`,
and the current owner authority boundary is exact-root-scoped read-only.

Historical design notes remain in `docs/`; they are not the runtime source of truth.
