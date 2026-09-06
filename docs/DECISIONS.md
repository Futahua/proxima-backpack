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

---

## D7 — Keep the hand-written parser for now; revisit before any writer exists

**Decided:** Proxima keeps its own frontmatter parser over a documented subset, rather
than adopting js-yaml or `yaml`. The parser must report everything it cannot represent,
and the raw frontmatter text is preserved byte-for-byte beside the interpreted values.

**Why not a real YAML parser today — the deciding fact:** the build is `tsc` alone.
There is no bundler, so a bare `import ... from 'js-yaml'` emits a specifier no browser
can resolve, and the page has no network and no Node to resolve it with. Adopting a
YAML library is therefore not a parser decision at all right now; it is a build
decision, and the build is Gate 2.2. Making it here would drag an unbuilt bundler into
a gate about reading files.

**Why the subset is defensible in the meantime:** the gate's requirement is not full
YAML support but that unsupported syntax cannot silently become plausible-but-wrong
domain data. That is now true, and it is the property that protects creator data.
Coverage of exotic YAML is a convenience; fail-visibility is a safety property.

**What this decision does not license.** A lossy parse must never be the source a
writer serializes from. `ParsedDocument.lossy` marks exactly the documents where the
interpreted values are not the whole truth, and `frontmatterRaw` is the lossless copy.

**Reverses if — and this is a hard requirement, not a preference:**

- **Before Gate 13 (the write model), unconditionally.** Round-tripping a file the
  parser only partly understands is how a creator loses a key another plugin owns. The
  parser question must be re-decided, with a bundler available, before any writer is
  built.
- Earlier, if a real creator vault turns out to use nested frontmatter routinely enough
  that "reported but unset" is a product defect rather than a safety net.

**Reversal is cheap by construction:** the parser is one module behind
`parseDocument`, and `tests/frontmatter.test.ts` is written against behaviour rather
than implementation. A YAML-backed replacement must pass the same suite — including
the issue-reporting cases, which a library alone will not satisfy.

---

## D8 — Invalid fields are substituted *and* reported, never silently

**Decided:** every field that affects current domain behavior has a defined valid range
or vocabulary. A value outside it is replaced with a safe default so nothing downstream
has to defend against NaN or invalid routing, and a `LoadProblem` is always emitted
saying which file, which field, and what was substituted. Descriptive fields such as
names, colours and linked-folder labels are not claimed to have artificial ranges.

**Why not reject the whole record:** a task with one bad number is still a real task the
creator can see in Obsidian. Dropping it would make Proxima disagree with the vault
about what exists, which is worse than showing it with a defaulted weight and a
warning.

**Why not carry the bad value:** the Elastic board turns numbers into geometry. A
negative `fixedDuration` runs the timeline cursor backwards over the previous task; a
zero `weight` gives a card no time while it still occupies the column. These are not
theoretical — they are what the unvalidated reader produced.

**Specific ranges and their reasoning** are in `docs/VAULT-FORMATS.md`. The two worth
repeating: `weight` must be `> 0`, and a duration must be `> 0` or absent — zero is
indistinguishable from unset, which `null` already says.

Project `status` and `projectType` are closed vocabularies because they control whether
a project is archived and whether it appears on the board or calendar. An invalid value
is reported before falling back; silently treating `projectType: schedul` as `task`
would route creator data to the wrong product surface.

**Reverses if:** a field turns out to have a legitimate use for a value this rejects,
in which case the range widens and the reason is recorded here.

---

## D9 — Elastic timelines reserve fixed work and never redistribute caps

**Decided:** the pure Elastic calculation first reserves every usable fixed duration,
then divides the remaining window among elastic tasks by positive weight. Each
`maxDuration` cap is applied independently; time removed by a cap is not redistributed.
Slices retain the caller's task order. A non-future or invalid date produces no
timeline, while an over-full fixed budget leaves later elastic slices at zero rather
than moving the cursor backwards.

**Why:** these rules preserve the old board's useful visual contract and make the
timeline explainable. In particular, independent caps avoid a hidden second pass that
would make one task's card change when an unrelated task becomes capped.

**Boundary:** the repository validates numbers and rejects duplicate logical ids before
calling the calculation. The pure function therefore assumes unique, finite,
positive-weight tasks; callers that bypass ingestion are outside the vault contract.

**Reverses if:** a verified old-plugin fixture or a creator requirement proves that
capped remainder must be redistributed, or that fixed work should be interleaved in
calculation rather than merely in output order.

---

## D10 — Calendar grouping uses the viewer's machine-local calendar

**Decided:** calendar grouping uses JavaScript's machine-local date fields. A dated
event covers every inclusive local calendar day from `startDate` through `deadline`.
If the deadline precedes the start, the event is shown on its start day only. An
invalid or missing start is not placed; a start without a deadline is a one-day event,
while a deadline without a start remains undated. Expansion is bounded at 36,600 days
(100 years); a larger finite span emits `event-span-too-large` and receives no calendar
buckets rather than being silently truncated.

**Why:** the original calendar is a local month grid, so a creator should see day
boundaries in the machine timezone rather than UTC boundaries. `setDate()` advances
calendar dates across month, year, and DST transitions without assuming every day is
24 hours.

**Determinism:** tests assert inclusive counts and derive boundary keys through the
same `localDateKey` helper instead of hard-coding one developer's timezone. The explicit
100-year bound prevents creator-controlled input from causing unbounded synchronous
work. Any future cross-machine shared-calendar requirement must introduce an explicit
injected timezone before the live surface is built.

**Reverses if:** creator acceptance requires the same event to land on identical date
keys regardless of viewer timezone.

---

## D11 — Build provenance records the working tree, not just the commit

**Decided:** the build identity carries `gitSha` (the exact commit, for machines),
`gitTreeState` (`clean` / `dirty` / `unknown`), `gitDirtyFileCount`, and `gitDescribe`
— the SHA with `-dirty` appended when the tree was modified. Untracked files count as
dirty. No git, or no repository, yields `unknown` rather than a build failure or an
invented hash.

**Why:** `git rev-parse HEAD` answers "what was the last commit", not "what did you
build". The previous generator stamped a clean 40-character SHA onto a build made from
a modified tree — demonstrated by editing a fixture without committing and watching
`fixtureHash` change while `gitSha` stayed put. Since the audit protocol's unit of
evidence is *"here is the exact pushed SHA"*, an identity that can name a commit it is
not turns a piece of evidence into a confident false claim.

**Why `gitDescribe` as well as a boolean:** a consumer reading only `gitSha` would
still quote a clean hash for a dirty build. `gitDescribe` is the quotable form, and it
cannot be misread.

**Why untracked counts as dirty:** `fixtures/` is bundled into the page wholesale, so
an uncommitted fixture file genuinely changes what was built even though git never
tracked it.

**Enforced by:** `tests/buildIdentity.test.ts` runs the real tool against throwaway
repositories under the OS temp directory — clean, modified-tracked, untracked, and
not-a-repository — and asserts the generated identity carries every provenance field.

**Reverses if:** never; a release build should additionally *refuse* to publish
evidence when `gitTreeState` is not `clean` (Gate 22).

---

## D12 — Calendar expansion returns its problems, never through an out-parameter

**Decided:** `eventsByDay(events)` returns `{ byDay, problems }`. It does not take a
`problems: LoadProblem[] = []` argument.

**Why:** an optional out-parameter reads as a convenience and behaves as a trapdoor. A
caller that forgets it receives a correct-looking map and loses the report entirely —
silently dropping the one diagnostic the function exists to raise, which is precisely
the failure mode Gate 1B was written to remove. Returning the problems makes ignoring
them a visible act rather than an omission, and matches `LoadResult`, which already
returns `{ state, problems, revisions, layout }`.

**Still open, deliberately not changed here:** an event exceeding
`MAX_CALENDAR_EVENT_DAYS` expands to no days at all, so it vanishes from the calendar.
"Invisible" and "too long to expand" look identical to the creator. Placing it on its
start day only may be the better failure mode; that is a product call, recorded here
rather than decided quietly.
