Read `README.md`, then read `AGENTS.md` and `HERMES.md` completely in the canonical
Papers repository at `D:\Letters\MatTroiSeConMoc\Products\Papers\Source` before acting.

This is the machine-local Proxima Backpack project. Modify it here. Do not place its
interface, domain model or file-format knowledge into Papers' compiled source, and do
not release Papers for ordinary changes to this project.

## The boundary that matters

This project exists because Proxima's logic previously bent to whatever Obsidian
supported. Do not repeat that with a different host.

- `src/domain/` imports nothing outside itself. No Obsidian, no Papers, no filesystem,
  no framework. If something needs a host, it belongs above the domain, behind a port.
- Papers may be asked for capabilities — read this granted file, open that path — never
  for meaning. A host operation named after a Proxima concept (`readProximaProject`,
  `saveExcalidraw`) is the failure mode, not the goal.
- Obsidian is a peer program that edits the same files. It is not an API to model
  against, and a compatibility shim that recreates `App`/`Vault`/`WorkspaceLeaf` is
  explicitly rejected.

## Vault safety

Proxima does not write to the vault. Obsidian is the only writer until a conflict model
is specified, reviewed and tested. `VaultWriter` in `src/ports/vault.ts` is a marker for
that future decision and is deliberately unimplemented.

Automated and agent-driven runs operate on `fixtures/`, never on a real vault. An
authenticated agent being able to drive Proxima must not become an agent being able to
mutate every file Proxima can see.

## Programmability

This project is expected to be driven by coding agents, so determinism is a feature:

- time and identity are injected (`src/domain/clock.ts`); nothing calls `Date.now()` or
  generates an id in a component;
- fixtures are real files with fixed ids and dates;
- `data-papers-visual-key` attributes are stable semantic names, keyed by domain id and
  never by list position. A refactor renames a key only when the meaning changes.

## Before requesting anything from Papers

Papers gains a capability only after a concrete failed test demonstrates the gap —
never because a host feature would be convenient. State the gap as a specific missing
truth, and ask for the smallest capability that satisfies it.
