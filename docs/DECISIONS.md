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

## D11 — Actions and inspection are project-owned, versioned seams

**Decided:** Proxima owns a small versioned semantic action catalog and a separate
read-only inspection projection in `src/app`. The browser delegates human interactions
to that dispatcher; tests call the same dispatcher. The projection contains bounded
domain summaries and safe source revisions, not renderer/store objects.

**Why:** an agent must be able to drive and inspect Proxima without learning the
implementation details of a UI framework or asking Papers to understand Proxima
concepts. Stable action names, validated inputs/outputs and machine-readable error
codes make the seam reproducible. Keeping it above `src/domain` preserves the domain
boundary while keeping host capabilities out of the protocol.

**Safety:** Gate 3A actions are read/navigation/reset operations only. `fixture.reset`
is rejected in live mode, and no action writes creator files. Live inspection omits
source paths; fixture inspection may include fixture-relative paths. Event sequencing,
settling and evidence transcripts remain separate Gate 3B work.

**Reverses if:** a later gate proves the catalog needs a different versioning or
transport model, in which case the existing action names and error codes remain
compatibility aliases for one migration window.

---

## D12 — Settling, events and evidence are injected and bounded

**Decided:** every accepted or rejected semantic action produces a versioned event
with a monotonic sequence, logical IDs, request ID, post-action revision and an
injected timestamp. Successful dispatches finish with a `state.settled` lifecycle
event. The ring is bounded in memory and readable by sequence. Scenario evidence is
versioned JSON with bounded transcripts and explicit build/fixture/revision/assertion
fields.

**Why:** agents need to know when a synchronous action has converged without sleeps,
and they need a reproducible account of what was requested, what changed and what was
observed. Injected clock/IDs keep fixture evidence stable; capacity and text limits
prevent a pathological run from becoming an unbounded serialization or memory sink.
Domain events and diagnostic rejections remain distinguishable by category.

**Boundary:** the event ring and evidence schema are Proxima-owned. Papers process
identity and capture artifacts are optional evidence fields supplied by acceptance
 tooling; this gate does not create a Papers control relay.

**Reverses if:** a later multi-surface gate requires durable cross-process event
storage, in which case the in-memory ring remains the local contract and gains an
explicit transport adapter rather than moving semantics into Papers.

## D13 — Repository adapters share a read-only conformance boundary

**Decided:** repository access remains behind the existing `VaultReader` port. Gate 4
adds a deterministic in-process memory adapter, a disposable real-disk adapter for
headless tests, and a browser-facing OPFS adapter over the structural directory/file
handle subset. A common conformance suite covers listing, recursive walking, reads,
existence, normalization, ordering, revisions, Unicode/punctuation, missing paths,
large reasonable text, and traversal rejection.

The disk tests create a temporary directory, mutate or rename only files under that
directory, and remove it in `finally`; they never point mutation tests at a creator
vault. Disk revisions combine mtime, size, and a content hash. Memory revisions are
deterministic counters and intentionally do not claim Windows or browser semantics.

The OPFS adapter intentionally does not invoke a picker or claim native
`FileSystemDirectoryHandle` permission, persistence, external-process contention, or
Windows absolute-path behaviour. Those facts require the disposable real-browser
FSA work in Gate 5. No Papers host capability is introduced by this gate.

**Reverses if:** a Gate 5 acceptance test demonstrates that the structural OPFS
contract is insufficient for a required read-only scenario; the missing capability
must then be named and justified before changing Papers.

## D14 — Unreadable-file tests use a portable fail-visible policy

**Decided:** an existing-but-unreadable file must remain observable as an existing
path and its read must reject visibly; it must never become an empty or stale value.
The disk conformance test pins that invariant with a deterministic `EACCES` reader
injection because native ACL/permission denial is not reliably manufacturable in a
Windows CI fixture. On platforms where permissions can be changed safely, a future
acceptance layer may add a native denial case; the injected case is the portable
fallback and is not presented as proof of Windows ACL semantics.

The disk conformance test also starts a separate Node process to append to the
disposable fixture, then verifies the reader observes the changed bytes and revision.
All mutation remains inside a temporary directory removed in `finally`.

**Reverses if:** a platform-specific acceptance requirement needs the exact native
permission or cross-process locking semantics; that requirement must be named before
expanding the adapter or Papers host surface.

## D15 — Gate 5 separates API availability from external grants

**Decided:** the real Papers `papers-backpack://` surface is a secure context and
exposes `showDirectoryPicker`, `showOpenFilePicker`, IndexedDB, and OPFS. A deferred
picker call rejects in the real surface, so the user-gesture requirement is recorded.
Disposable OPFS and IndexedDB round-trips are also proven and cleaned up. These facts
do not count as an external-directory grant: enumeration, file reads, permission
state, handle persistence, restart behaviour, and creator-vault read-only safety
remain unchecked until a foreground picker selection can be exercised.

No host capability or real-vault access is justified by API availability alone. If
the native picker cannot complete a disposable external-directory read in Papers,
that exact failed acceptance test becomes the only basis for a later host request.

## D16 — Gate 5 core proves disposable read-only FSA viability

**Decided:** the Gate 5 core acceptance slice is complete for a disposable external
directory. A foreground picker selection enumerated and read bounded relative entries;
a separate Node process changed a fixture file; a cached handle reread observed the
new bytes and revision; the handle was restored from IndexedDB after an in-place
Papers reload; and a foreground read permission request restored `prompt` to `granted`.
The report never emits an absolute path. The implementation keeps the handle module-
local and performs no creator-vault writes.

This is a viability result, not the full product gate. Clean-profile behaviour, a full
Papers process restart, real creator-vault read-only acceptance, live Obsidian edits,
and any write/concurrency semantics remain separate follow-ups. Until those are
accepted, Proxima remains read-only and no Papers host bridge is justified.

## D17 — Persisted disposable handle survives a full Papers lifecycle

**Decided:** the Gate 5 full-process restart follow-up passes for the disposable
fixture. After a normal Papers exit and relaunch using the same acceptance profile,
Proxima restored the persisted `gate5-fsa-fixture` handle without a new picker.
`queryPermission({mode:'read'})` was `granted`; the bounded relative projection
contained the nested file tree, `persisted: true`, and `root-note.txt` still contained
the independently appended `external-fsa-edit-v1` marker. No absolute path or creator
vault data appeared.

This closes the full-process lifecycle truth for the disposable folder only. Clean
profile behavior, creator-vault read-only acceptance, Obsidian live edits, and
write/concurrency semantics remain open and are not inferred from this result.

## D18 — Clean-profile acceptance is isolated and foreground-gated

**Decided:** the next acceptance uses a genuinely separate Papers data directory
containing only the Backpack registry/binding metadata needed to launch Proxima; no
IndexedDB or inherited FSA handle is copied. Its external fixture is also distinct
and disposable, with a fresh initial marker. The clean-profile result must begin with
the expected no-handle state and may become a PASS only after a real foreground
picker selection and the bounded read/edit/reload checks.

No creator-vault data is part of this preparation. The clean profile does not prove
cross-profile persistence; it proves that browser-native FSA works from a fresh
profile after its own explicit grant.

## D19 — FSA acceptance evidence is bounded and reproducible

**Decided:** the Gate 5 report remains a small JSON projection of the granted handle:
permission state, handle name, relative entries, bounded text markers/revisions, and
the persisted flag. `src/app/fsaEvidence.ts` validates that projection without
introducing filesystem or host dependencies: absolute paths, traversal segments,
duplicate entries, invalid kinds, and unbounded fields fail visibly. The disposable
clean-profile fixture can be reset only through the fixed-path
`tools/reset-gate5-clean-fixture.mjs` helper.

**Why:** a reviewer must be able to consume acceptance output mechanically while
ensuring a report cannot accidentally disclose machine paths or grow without bound.
The reset helper makes the final foreground test repeatable and cannot target an
arbitrary user-selected directory.

**Boundary:** this validates evidence and prepares disposable data; it does not grant
permissions, drive a native picker, or claim clean-profile/creator-vault acceptance.

## D20 — Remaining Gate 5 acceptance is explicitly deferred

**Decided:** the remaining interactive and real-vault checkpoints are intentionally
deferred: clean-profile native picker/read, creator-vault read-only access, Obsidian
coexistence, and write/concurrency semantics. The reviewer ledger records these as
`DEFERRED / OPEN`; no later gate may be treated as complete or inferred from the
earlier disposable-fixture passes.

**Why:** the user elected to skip the remaining foreground/native handling for this
run. Keeping the items open preserves the audit boundary and avoids claiming evidence
that was not collected.

**Reverses if:** the user explicitly resumes Gate 5 with a new acceptance run.

## D23 — Autonomous work resumes after a figurative skip request

**Decided:** the earlier D20 pause was a workflow clarification, not abandonment.
Autonomous implementation, testing, documentation, and reviewer audits continue.
The current Gate 5 state is OPEN pending the single native clean-profile picker
action; creator-vault, Obsidian, and write/concurrency checks remain sequenced after
that boundary.

**Boundary:** no deferred or open item is promoted to PASS without its required
runtime evidence.

## D24 — Gate 6A starts with pull-based read-only refresh

**Decided:** source refresh is owned by a Proxima `RefreshController` over the
existing `VaultReader` seam. `refreshSource(reason)` accepts only the closed reasons
`manual`, `focus`, `interval`, or `external-signal`; rereads and parses a fresh
snapshot, compares revisions and logical identities, serializes concurrent calls,
and publishes a new source revision only when observable state changes. Unreadable or
malformed refreshes preserve the last good state while exposing bounded degraded,
stale, and problem-code fields. The controller has no writer, migration, autofix,
filesystem, Papers, or creator-vault authority.

Manual refresh is the correctness baseline. Focus-triggered, interval, and external
signals may reuse the same controller; no watcher or Papers host capability is
justified until measured evidence shows pull refresh is insufficient.

**Boundary:** Gate 6A is fixture/disk-adapter only and does not claim real-vault
acceptance or advance the native FSA boundary.

## D25 — Gate 6B projects one accepted refresh generation

**Decided:** Projects, Elastic Board, Calendar, and inspection consume a bounded
`ReadOnlyProjection` created from one accepted `RefreshControllerSnapshot`. The
projection copies state, revisions, and problems; carries source kind, logical id,
relative source path, source revision, and id origin for every exposed record; and
publishes source/app revision, stale/degraded health, last successful refresh, last
reason, and bounded problem codes. It never rereads the source or exposes a reader,
controller, file handle, or mutable internal object.

Successful edits advance all consumers together. Malformed or unreadable refreshes
keep the last-good domain generation visible while health becomes stale/degraded;
recovery advances the generation atomically. Board elastic allocation and Calendar's
problem sink remain the existing domain functions.

**Boundary:** Gate 6B is fixture/disposable-reader only. It does not claim real-vault,
native FSA, Obsidian, polling, or Papers-host acceptance.

## D26 — Gate 6C uses an adapter-driven pull-refresh policy

**Decided:** trigger policy is a separate `RefreshPolicy` above the 6A controller.
It accepts only `manual`, `focus`, `interval`, and `external-signal`, routes every
trigger through `refreshSource(reason)`, clamps interval polling to a nonzero
minimum, coalesces in-flight trigger storms, and makes start/stop/disposal
idempotent and timer-safe. Visibility is supplied through `setVisible`; hidden
interval polling is suspended and one focus refresh is issued on return.

The policy exposes bounded inspection state and never imports or stores DOM/window,
Papers, FSA, creator-vault, or watcher objects. Failed refreshes do not create tight
retry loops; recovery requires a later legitimate trigger. Browser lifecycle wiring,
if needed, remains an outer adapter with injected callbacks.

**Boundary:** Gate 6C remains fixture/disposable-reader only. H2 watcher capability,
real-vault acceptance, and native picker handling stay deferred.

## D27 — One bounded health model serves UI and inspection

**Decided:** stale/degraded state is normalized by `createUiHealthModel` from the
accepted read-only projection. The browser renders one stable C1 health surface with
the source/application generation, status, last successful refresh, last reason, and
bounded problem codes; inspection exposes the same copy-safe model. Board, Projects,
and Calendar therefore cannot disagree about the generation or turn stale into an
empty-data state.

Unreadable or malformed refreshes retain the last-good domain content while the
health surface changes visibly; recovery clears the indicator and advances the
generation. UI and inspection never receive a reader, controller, file handle, DOM
object, or absolute path authority.

**Boundary:** Gate 6D is fixture-only. Real-vault UI, native FSA, and host lifecycle
acceptance remain open.

## D28 — Fixture browser refreshes replace the source generation atomically

**Decided:** the fixture browser bootstrap now instantiates the complete read-only
chain: mutable fixture `VaultReader`, `RefreshController`, `RefreshPolicy`,
`ReadOnlyProjection`, `UiHealthModel`, dispatcher, inspection, and UI. A stable
`source-refresh` C1 control routes through policy `manual`; policy results are applied
through the dispatcher's atomic `replaceSource` seam. Policy observers also apply
interval/focus results, while DOM visibility/focus listeners remain an outer adapter.

Unchanged refreshes do not advance source or application generation. Successful edits
replace the dispatcher source in one settled generation; deletion reconciles selected
projects and visible records. Failed refreshes update only the health projection and
retain last-good UI content; recovery replaces the generation without reload. The
dispatcher records bounded lifecycle events and keeps pending operations empty.

**Boundary:** Gate 6E uses only mutable in-memory fixture bytes. It does not touch FSA,
the creator vault, Obsidian, Papers, native watchers, or any writer/migration path.

## D29 — External directory handles stop at the reader adapter

**Decided:** an injected structural `FileSystemDirectoryHandle`-like object is adapted
by `createExternalDirectoryVault` into the existing `VaultReader` contract. The
adapter reuses path normalization, rejects traversal, sorts deterministic results,
and bounds recursive entries, depth, and file size. It performs only `getFile()` and
text reads; permission requests, writable handles, remove/rename, and migration APIs
are outside the adapter.

The browser source factory accepts an injected reader or directory as an explicit test
seam while fixture mode remains default. Once adapted, only `VaultReader` crosses into
the refresh stack: raw handles never enter domain state, dispatcher, inspection,
globals, or action results. External edits, deletion/rename, and read failures reuse
the existing 6A–6E refresh, projection, health, and last-good semantics.

**Boundary:** Gate 6F is injected-handle/fixture-only and does not select a native
directory, request permission, persist handles, touch the creator vault, or change
Papers/Obsidian.

## D30 — Restored-handle bootstrap is permission-query-only

**Decided:** persisted-handle entry is isolated behind injected `RestoredHandleStore`
and `ReadPermissionProvider` seams. Bootstrap calls only
`queryPermission({ mode: 'read' })`; it never calls `requestPermission`, opens a
picker, or writes IndexedDB. `granted` creates the existing external-directory
`VaultReader`; `prompt` and `denied` return bounded permission-required/denied
inspection and fall back to the fixture source. Restore/query/shape failures are
explicit bounded bootstrap problems.

Only safe handle metadata (directory kind and a sanitized bounded name) is exposed;
the raw handle is discarded at the adapter boundary. A restored granted reader uses
the same 6F–6E refresh, projection, health, dispatcher, and UI path as every other
source. Persistence remains an injected repository concern.

**Boundary:** Gate 6G uses mocked structural handles only. Native acquisition,
creator-vault selection, permission prompts, and Papers/host changes remain open.

## D31 — Source-mode transitions are serialized and authority-dropping

**Decided:** `SourceSession` is the sole source-mode state machine above source
creation/bootstrap. Its modes are closed to `fixture` and `external`; transitions
are generation-tagged and serialized, and active policies are disposed before a
switch. Only an already-authorized `VaultReader` plus its loaded snapshot may be
activated. The state machine never acquires permission, calls a picker, touches
IndexedDB/filesystem APIs, or retains raw handles.

Successful switches replace one complete projection generation. Failed external
activation keeps the previous stable source and reports a bounded failure state.
Late refresh completions from a detached source are ignored; switching back to the
fixture drops external authority references. Active policy timers/triggers bind only
to the current source, while dispatcher/selection/settled semantics remain owned by
the existing atomic source replacement seam.

**Boundary:** Gate 6H is code-only with injected readers and mocked scheduling.
Native acquisition, creator-vault use, and real-source acceptance stay open.

## D32 — Restart restoration composes bootstrap and one source session

**Decided:** `StartupSessionOrchestrator` consumes the 6G bootstrap result and
initializes exactly one 6H `SourceSession`. No restored handle falls back to fixture;
granted restoration loads the external source once and enters the same session path;
prompt, denied, query failure, and granted activation failure remain fixture-stable
with bounded bootstrap metadata. Repeated `start()` on one orchestrator is idempotent.

Each orchestrator/session is disposable. Permission loss after a granted boot flows
through the normal refresh controller/policy degradation and last-good projection;
a newly constructed granted restart creates a clean external session and cannot inherit
stale state or late commits from the disposed instance. Startup inspection exposes only
source mode, restored-handle presence, bootstrap status, source generation, session
state, and bounded problem codes.

**Boundary:** Gate 6I uses structural mocked handles and injected stores/providers.
It does not persist handles, request permission, select a native directory, or touch
creator-vault/Papers/host APIs.

## D33 — Real-vault readiness is a staged, pure evidence contract

**Decided:** real-vault readiness is evaluated by a bounded pure evaluator over
startup/session/projection/health/inspection snapshots and explicit refresh evidence.
It requires an external, granted, stable, healthy baseline with coherent generation
and provenance samples, then reports separate baseline-read, external-edit,
rename/delete, Obsidian-coexistence, and write-invariant stages. Missing later-stage
evidence is `OPEN`, not inferred; an overall pass requires the required read/edit/
rename/write stages. Absolute or traversal paths, mixed generations, stale/degraded
state, missing provenance, unchanged edit claims, and any writer invocation fail
closed without echoing sensitive paths.

The browser surface accepts only the bounded report for display; the evaluator and
render hook call no picker, filesystem, FSA, IndexedDB, Papers, controller, reader,
or writer APIs. This is readiness evidence, not creator-vault selection or write
authorization.

**Boundary:** Gate 6J proves the report contract and fixture-level evaluator tests.
Native creator-vault selection, real-directory integration, Obsidian coexistence,
and any write capability remain open for later gates.

## D34 — Live browser acceptance consumes the one startup/session path

**Decided:** the browser bootstrap now composes the 6I startup orchestrator with a
fixture candidate and an injected restored-handle seam. The default remains a
fixture when no restored handle exists; an already-granted external candidate would
enter the same `SourceSession` path, with no parallel real-vault controller. Source
projections replace the dispatcher atomically, and the browser recomputes the 6J
report after startup and every accepted refresh. Edit evidence comes from the normal
refresh result plus before/after accepted projections; rename/delete evidence comes
from source identity/path deltas, never a manually supplied PASS bit.

The live seam exposes only the copy-safe inspection and validated acceptance report.
It retains no raw handle, reader, session, controller, policy, store, permission
provider, or DOM authority in the global surface. Fixture startup is explicitly
non-PASS, while external edits, unreadable/last-good degradation, recovery, and
stale-source callback suppression remain covered by the existing session tests.

**Boundary:** Gate 6K still uses injected structural sources in tests. It does not
invoke a native picker, request permission, select a creator vault, change Papers,
or enable writes.

## D35 — Creator-vault runbook is a pure preflight guard

**Decided:** before any native creator-vault grant, `evaluateRealVaultRunbook`
requires a bounded external/granted/stable/healthy Gate 6J baseline, matching build
and optional root, provenance, and a hard zero-write invariant. It emits bounded
`READY`, `BLOCKED`, or `ABORTED` status, explicit evidence stages, abort codes, and
the one remaining native boundary (`select-and-grant` only when no authorized
external source exists). Missing later edit/rename/Obsidian evidence is documented
as capture work, never inferred as success; any writer invocation aborts.

The guard has no picker, permission, filesystem, Papers, reader, controller, policy,
or writer authority and never repairs or writes on abort. The report is suitable for
copy-safe browser rendering without creator-vault paths or authority objects.

**Boundary:** Gate 6L is a readiness/runbook contract only. It does not select a
creator vault or claim real-vault behavior.

## D36 — Peer-writer coexistence is tested on disposable disk only

**Decided:** Gate 6M uses a temporary disk fixture and a separate child-process
writer actor to simulate Obsidian-like edits. Proxima consumes the files only through
the existing read-only `VaultReader`/`SourceSession` stack and observes changes after
normal refresh. Tests cover edit, create, rename, delete/selection reconciliation,
malformed intermediate state with last-good degradation, valid recovery, rapid peer
changes, generation coherence, and a zero Proxima write count. No Obsidian API or
plugin runtime is introduced.

**Boundary:** the disposable writer is test-only; no creator vault, native picker,
Papers bridge, watcher capability, or write authority is added.

## D37 — Native-grant readiness is one deterministic final preflight

**Decided:** `evaluateCreatorVaultPreflight` composes only bounded 6J acceptance,
6L runbook, and 6M coexistence-readiness outputs. It emits one copy-safe
`READY_FOR_NATIVE_GRANT`, `BLOCKED`, or `ABORTED` decision with exact blocker codes,
read-only/zero-write invariants, forbidden upcoming operations, and the sole allowed
next native action: select/grant the creator vault read-only directory. Clean-profile
FSA selection and real Obsidian coexistence remain explicitly `OPEN`; disposable
simulation is the only readiness evidence counted.

The evaluator is deterministic and side-effect free. It calls no picker, permission,
filesystem, Papers, reader, session, controller, or writer API and never echoes unsafe
paths or authority objects.

**Boundary:** Gate 6N is final preflight only. It does not perform native selection,
claim creator-vault behavior, or enable writes.

## D38 — Automation uses a loopback read-only bridge instead of a picker gesture

**Decided:** agents may bootstrap a browser session against an explicitly configured
creator-vault root through a loopback HTTP bridge. The bridge is GET/OPTIONS-only,
loopback-bound, path-safe, bounded by depth/entry/byte limits, and structurally adapted
to the existing read-only vault seam. Browser startup treats it as a restored granted
source, so the normal discovery, session, runbook, and preflight checks still run.

The root must be supplied explicitly; the bridge does not crawl the machine, infer a
creator vault, write files, migrate data, watch the filesystem, invoke Papers, or grant
native permissions. Native creator-vault selection and real Obsidian coexistence remain
separate OPEN acceptance work.

**The bridge cannot operate inside Papers, and this is architectural rather than
incidental.** A Papers-hosted Backpack page is served from a `papers-backpack://<id>`
origin under a fixed CSP whose `connect-src` is `'none'`, so the page cannot issue the
bridge's HTTP requests at all, and the bridge's own CORS reflection would not match that
origin in any case. The bridge is therefore a dev/agent transport only.

The consequence for every future reader of an acceptance report: **bridge-backed
acceptance proves Proxima's read-only domain, session and evidence behaviour against a
real creator vault. It proves nothing about Papers-hosted access, FSA permission, or
native Papers integration**, all of which remain independently OPEN. A result that does
not carry `transport` and `papersHosted` is not usable as Papers evidence.

## D39 — Zero-write and readiness must be provable, not asserted

**Decided:** an invariant is only recorded once something would fail if it were false.

Two assertions in the Gate 6M/6N layer looked like evidence and were not. A coexistence
test declared `const writerCalls: string[] = []` and asserted it stayed empty, while
nothing ever appended to it — the assertion would have held had Proxima rewritten every
file in the vault. The browser surface passed a literal
`{ passed: false, zeroWrites: true, sourceBoundsValid: true, hostCapabilityResolved: true }`
into the preflight: the `false` made `READY_FOR_NATIVE_GRANT` unreachable regardless of
evidence, and the three `true`s claimed facts nobody had observed.

Both are now structural. Zero-write is witnessed by a proxied reader that records reads,
throws on anything outside `list/read/exists/walk`, and fingerprints the tree so an
unattributed change fails the run; the witness fails if it recorded no reads at all, so
an unwired instrument cannot report success. Coexistence readiness is a declared input
defaulting to every field false, coerced from literal `true` only, and the surface never
infers it.

**Boundary:** this changes how the invariants are proved, not what they claim. A
declared readiness is still only as good as the run that produced it, and Gate 6P must
supply it from an actual acceptance run rather than a constant.

## D21 — Clean-profile acceptance is evaluated from captured evidence

**Decided:** before the one remaining native picker action, Proxima now has a pure
clean-profile acceptance harness. It consumes the actual FSA report through the
bounded validator, requires the exact disposable handle and four-entry shape,
checks the initial marker, granted permission, and persisted handle, and emits
bounded build identity, observed paths, and structured failure codes. It never calls
browser, filesystem, Papers, or IndexedDB APIs. Tests cover missing/extra/duplicate
entries, absolute-path leakage, malformed fields, wrong handle, missing marker,
permission/persistence failures, and the fixed-path reset utility.

**Boundary:** this is evidence readiness only. It does not claim the clean-profile
picker/read acceptance, creator-vault access, Obsidian coexistence, or write safety.

## D22 — The browser surface emits the clean-profile verdict automatically

**Decided:** every FSA probe result rendered by the browser surface is accompanied
by the pure clean-profile acceptance projection and the current build identity. The
native picker still supplies the only user gesture, but once a report exists the
surface emits the bounded PASS/FAIL result and structured failure codes itself; no
manual transcription or second inspection step is part of the acceptance path.

**Boundary:** reports for the already-used core fixture intentionally fail the
clean-profile handle/marker assertions. This is diagnostic separation, not a claim
that the core fixture is the clean-profile fixture.

## D40 — Canvas nodes own identity and keep arbitrary files passive

**Decided:** Gate 8 begins with a pure, headless canvas node model. A node receives
its stable Proxima-owned id from the injected `IdGenerator`; its canvas layout is
separate from the vault-relative source locator and the source's observed revision,
size and modified time. Rename/re-observe changes source provenance without changing
node identity or layout. Missing and unavailable sources remain first-class node
states and retain last-known metadata rather than disappearing.

Every vault locator is rejected unless it is already canonical and relative: absolute,
drive, traversal, empty-component and backslash forms are not repaired. The first
representation is a total passive fallback card exposing filename, lowercase
extension, optional metadata and source state. No source is read here, and no HTML,
JavaScript, executable or other active content is ever treated as inline preview.

Canvas workspace state remains separate from source-derived `ProximaState`; renderer
selection, binary reads, external grants, directories and drag/drop require later
decisions and tests.
