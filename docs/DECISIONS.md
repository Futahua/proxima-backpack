# Decisions

Choices the audit checklist requires to be made explicitly rather than left implied.
Each one records what was decided, why, and what would reverse it.

---

## D1 — `systemClock` and random ids stay in `src/domain/clock.ts`

**Decided:** the injectable *interfaces* (`Clock`, `IdGenerator`) and all
implementations — `systemClock`, `randomIdGenerator`, `fixedClock`,
`sequentialIdGenerator` — live together in `src/domain/clock.ts`.

**Why:** the boundary that matters is *injection*, not *location*. `systemClock` is
four lines of pure declaration; it reads `Date.now()` only when something calls it, and
nothing in the domain calls it. Moving it out would buy the appearance of purity while
making the seam harder to find, and the real risk — a component reaching for
`Date.now()` directly — is not addressed by where the production implementation is
filed.

**Enforced by:** `tests/boundaries.test.ts` fails if any domain module other than
`clock.ts` calls `Date.now()`, `crypto.randomUUID()` or `Math.random()`.

**Reverses if:** the domain is ever bundled somewhere `Date.now` or `crypto` is absent
or forbidden, or a lint rule needs a file-level boundary rather than a test-level one.

---

## D2 — The logical id is not the source path

**Decided:** records carry a logical `id` and a separate `source: SourceRef`. A file
declaring `id:` keeps that identity across renames; a file without one falls back to its
own basename, not its full path.

**Why:** the previous reader used path-minus-`.md` as the fallback identity, which made
the path *be* the identity. Under that rule, moving a file silently creates a new record
and renaming one silently destroys the old — and, once writes exist, an id that encodes
a path can send a write to a file nobody chose.

**Cost accepted:** a derived id is only unique within its directory, so two records in
different directories could in principle collide. They are detected rather than
tolerated (see D3).

**Reverses if:** never, without a written conflict model.

---

## D3 — A duplicate logical id is refused, not resolved

**Decided:** the first record in path order enters state; a second claiming the same id
of the same kind is rejected and reported as a `duplicate-id` error.

**Why:** "last one wins" and "first one wins" are both silent, and a silently aliased id
is exactly the state in which a later write or agent command hits the wrong file. The
candidate list is sorted before reading, so the winner is deterministic and the report
names the file that already holds the id.

**Alternative rejected:** disambiguating automatically (suffixing, or falling back to
the path). That invents an identity the creator never wrote and would then have to be
kept stable forever.

---

## D4 — Discovery is positional, with a project-only frontmatter veto

**Decided:** a file's location decides whether it is a record. `type: project` is
honoured but neither required nor promoting; its only power is to veto a file **in the
projects directory** that says it is something else. On a task or an event, `type:` is
never read.

**Why:** "any Markdown under the folder is a record" makes a vault fragile — a note
dropped beside a project becomes a phantom project that cannot be deleted without
deleting the note. Requiring `type:` instead would break every preferred-format file,
none of which carries one.

**Why project-only:** the plugin's project scan required `type: project`; its task and
event loaders never looked at `type`. Generalising the marker into a universal
`project`/`task`/`event` discriminator — which the first Gate 1A implementation did —
is a compatibility regression, not a tightening: a legacy task written as `type: todo`,
or an event carrying another application's `type:`, is a real record that would
silently leave state with only a warning to show for it. Scope the veto to the one kind
there is evidence for.

**Enforced by:** `tests/identity.test.ts` loads a legacy task with `type: todo` and an
event with `type: meeting` from real fixture bytes, and asserts neither produces a
problem.

**Known limitation, accepted and documented:** a stray note in `projects/` declaring no
`type` is read as a project. The legacy flat format has no marker to distinguish them.
See `docs/VAULT-FORMATS.md`.

**Reverses if:** creator data turns up showing `type` was in fact a task or event
discriminator, in which case the veto widens to the kinds that evidence covers — and
only those.

---

## D5 — Tasks and events are read from direct children only

**Decided:** `tasks/{id}.md` and `events/{id}.md` only. Markdown nested deeper is not
read, and is reported as `ignored-file`.

**Why:** no supported layout puts a task in a subfolder, so a file there is more likely
misplaced than deliberate. Reading it would invent a layout; ignoring it silently would
hide a task the creator believes exists. Reporting it does neither.

**Reverses if:** a real creator vault turns out to organise tasks in subfolders, in
which case the layout gains a documented recursive mode rather than a silent one.

---

## D6 — `src/` typechecks with no ambient Node types

**Decided:** the root `tsconfig.json` sets `"types": []` and includes `src` only. Tests
get Node types through `tsconfig.tests.json`.

**Why:** Proxima runs in a page with no filesystem and no Node. An `import ... from
'node:fs'` in the domain should fail at build time, not at runtime in front of the
creator. This turns a documented rule into a mechanical one.

**Reverses if:** a real on-disk adapter is added for headless conformance tests
(Gate 4.3). That adapter needs Node types and will get its own project reference —
`src/domain` keeps none.
