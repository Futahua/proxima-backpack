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

### D7 write-era re-decision — semantic writes patch source spans

**Decided:** the hand-written parser remains an interpretation layer only. The first
semantic writer patches the exact bounded UTF-8 source span for one unambiguous,
existing top-level scalar and conditionally commits the resulting bytes. It never
serializes `ParsedDocument.frontmatter`.

**Why:** a document may be lossy because of unrelated nested YAML, block scalars,
anchors or aliases. Copying every byte except the owned scalar preserves those creator-
or plugin-owned regions without requiring a generic YAML serializer.

**Current slice:** only `status:` on an existing top-level task frontmatter line is
writable. Missing, duplicate, nested, structured or ambiguous targets refuse visibly;
broader YAML editing and adding keys remain deferred.

**Historical scope note:** the "Current slice" paragraph above records the first
write-era implementation slice at the time this decision was re-made. Its narrow
`status:`-only scope is not the current mutation surface.

Gate 13 later added typed semantic mutation across task, project and event records,
including bounded optional-field insertion and clear, canonical record creation, and
record lifecycle. Those later writers preserve this decision's load-bearing invariant:
existing creator files are changed through bounded source-preserving operations rather
than by serializing the interpreted `ParsedDocument.frontmatter` projection, and
canonical new records are emitted from closed semantic templates rather than a generic
YAML serializer.

See `docs/AUDIT-CHECKLIST.md` Gate 13.2 through 13.2T for the later implementation
record. This annotation updates implementation scope only; it does not reverse D7.

**Reverses if:** a future writer needs structural YAML edits that cannot be expressed as
a bounded source-span patch; that gate must adopt a real lossless YAML/build strategy
before expanding the writable surface.

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

**Decided:** calendar grouping uses machine-local date fields for explicit timestamps,
while exact `YYYY-MM-DD` values are strict Gregorian civil dates and are never shifted
through UTC. A dated event covers every inclusive local/civil calendar day from
`startDate` through `deadline`.
If the deadline precedes the start, the event is shown on its start day only. An
invalid or missing start is not placed; a start without a deadline is a one-day event,
while a deadline without a start remains undated. Expansion is bounded at 36,600 days
(100 years); a larger finite span emits `event-span-too-large` and receives no calendar
buckets rather than being silently truncated.

**Why:** the original calendar is a local month grid, so a creator should see day
boundaries in the machine timezone rather than UTC boundaries. Date-only frontmatter is
already a civil date, so parsing it as UTC midnight would move it across a negative
offset boundary. Civil-day iteration advances across month, year, and DST transitions
without assuming every day is 24 hours.

**Determinism:** tests assert inclusive counts, exact civil-date bounds and invalid-date
diagnostics, while explicit timestamp boundary keys use the same `localDateKey` helper
instead of hard-coding one developer's timezone. The explicit 100-year bound prevents
creator-controlled input from causing unbounded synchronous work. Any future
cross-machine shared-calendar requirement must introduce an explicit injected timezone
before the live surface is built.

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

## D41 — Renderer selection is declarative, bounded and total

**Decided:** renderer selection is a pure domain classification over an already
authorised, bounded payload. The registry order is Excalidraw by structure, text by
an explicit small extension allowlist, raster image by byte signature, then passive
fallback. A missing/unavailable source, absent payload, oversized payload, invalid
media and unknown format all remain visible fallback outcomes with bounded reasons.

HTML, SVG, JavaScript, WebAssembly, executables and other active-content extensions
never become inline representations in this slice. Active content may enter
classification only as already-authorised, bounded inert data; the selector receives
no reader, filesystem handle, URL, DOM, callback or execution authority. Binary
acquisition, object-URL lifecycle and browser rendering remain later
application/surface work.

## D45 — Raster previews are browser-owned, bounded and revocable

**Decided:** only a signature-selected passive raster may transfer a bounded,
one-shot byte seed from browser admission to the browser-only preview registry. The
registry is the sole Blob/object-URL owner, with independent 64 MiB aggregate-byte
and 32-item ceilings; it stores URL/media/byte-count metadata, revokes on replacement,
node removal and page teardown, and keeps the old URL if replacement creation fails.
Canvas/domain/app state remains free of File, Blob, bytes and URL authority. Canvas
surface switching is not unmount; the workspace continues to own its previews.

**Boundary:** this slice renders raster `<img>` previews only. Text, Markdown,
Excalidraw, SVG, PDF, directories, durable grants, persistence, rebinding,
drag/move/resize, public browser-data actions and writes remain deferred.

This decision supersedes D43–D44 only for the raster presentation exception; their
non-raster and authority boundaries remain in force.

## D46 — Excalidraw previews are scene-only and generated in the browser

**Decided:** when one-shot browser admission structurally decodes an Excalidraw
scene, it may transfer that scene once to a browser-only preview registry. The
registry immediately calls the signed pure renderer with an empty asset map and
retains only generated SVG, bounded census/problems and character length; it never
retains source text, scene objects, File/Blob/bytes, vault readers or attachment
authority. Generated SVG is bounded per item and in aggregate, and replacement,
removal, page teardown and BFCache handling are explicit and idempotent.

**Boundary:** unresolved image assets remain visible placeholders and diagnostics;
no attachment reads or durable rebinding are implied. Text/Markdown, SVG, PDF,
directories, persistence, public browser-data actions and writes remain deferred.

This decision supersedes D44–D45 only for scene-only Excalidraw presentation; their
raster, text, SVG/PDF and authority boundaries remain in force.

## D50 — Gate 7 compatibility is direct-source display/reference only

**Decided:** the implemented Excalidraw compatibility contract is Level A
display/reference fidelity for the audited creator-vault subset and supported
scene/asset types. Proxima uses structural source parsing, bounded decoding and a
pure SVG renderer; it does not depend on Obsidian auto-export files or the upstream
Excalidraw editor runtime.

**Boundary:** Level B core editing/round-trip is deferred to later write/editing
work. Level C broad Obsidian-plugin compatibility is not claimed. Plugin-specific
links/transclusions and unsupported scene constructs remain narrower or fail-visible
rather than silently becoming a second compatibility contract. The historical
7.1–7.5 checklist prose remains for context only and must not be read as an
unfinished requirement for the signed direct-source route.

## D47 — Text previews are literal, escaped and browser-owned

**Decided:** supported text selections may transfer the already-decoded bounded
string once into a browser-only text-preview registry. The Canvas surface renders
only escaped literal `<pre>` content, with a stricter per-item, aggregate and item
budget; oversize presentation remains a visible unavailable diagnostic with no
silent truncation. Markdown is not parsed, and no links, images, HTML, network,
object URLs or attachment resolution are introduced.

**Boundary:** active content still exits before acquisition; Excalidraw precedence
remains absolute; Canvas/domain/app state, action protocol, persistence, grants and
writes remain unchanged. SVG and PDF remain passive/deferred.

This decision supersedes D44–D46 only for escaped literal text/Markdown
presentation; SVG/PDF and all authority boundaries remain unchanged.

## D48 — Fallback icons are static local category tokens

**Decided:** fallback cards may show a fixed local token derived from already-known
selection metadata (`TXT`, `IMG`, `DRAW`, `SVG`, `PDF`, `SAFE` or `FILE`). The
mapping is pure, total and display-only; it performs no reads, MIME trust, native
icon lookup, network access, URL/object-URL creation or renderer authorization.

**Boundary:** the token never changes selection, active-content veto or preview
routing, and no source bytes or thumbnails are generated or retained. Durable
external grants, directories, source SVG and PDF rendering remain scope decisions.

## D44 — Canvas surface renders passive drop cards only

**Decided:** the browser surface may accept a bounded `DataTransfer.files` batch and
feed each File through the signed Gate 8B admission seam sequentially. It retains
only capability-free node, selection and status values, renders escaped metadata
cards (including active, oversized, unavailable and unsupported reasons), preserves
duplicate admissions, and reports files beyond the finite per-drop limit. The Canvas
surface is a third action surface; project selection remains untouched and vault
refresh replaces only source-derived state.

**Boundary:** no File/Blob/bytes are retained after admission, no path/directory
metadata or handles are inspected, and no public action carries browser data. Inline
text/Excalidraw/SVG/PDF rendering, persistence, durable grants, drag/move/resize and
writes remain deferred; raster presentation and object-URL ownership are defined by
D45.

## D43 — Browser File admission is ephemeral and one-shot

**Decided:** a browser `File` may be admitted once through the browser adapter as a
second, explicitly non-vault source kind. Proxima generates separate node and source
identities; filename, MIME, size, modified time and any path-like browser metadata
never determine either id or become a vault locator. The adapter checks active-content
and the 16 MiB byte ceiling before `arrayBuffer()`, performs at most one bounded
acquisition, and reuses those inert bytes for structural/text and signature
classification. Restart marks the source unavailable; no filename-based rebinding or
durable handle is implied. Duplicate admissions remain independent nodes.

**Boundary:** the `File` object never enters domain or retained canvas state. Visible
drop handlers for passive cards, external grants, directories, source rebinding,
persistence and writes remain later work; raster browser presentation is defined by
D45.

## D42 — Canvas source reads stay bounded and provenance-bearing

**Decided:** the app-layer canvas loader is the only Gate 8 slice that spends source
I/O. It validates the vault-relative locator, skips active-content extensions without
reading them, asks text sources for the selector's character bound, and asks the
optional binary seam for the selector's byte bound. Returned path, revision, size and
modified time become the read-time source observation passed to the pure selector.
Missing capability and read failure are explicit passive outcomes; node identity and
layout are preserved, and no reader or handle crosses into the domain.

**Boundary:** this does not add browser drag/drop, external grants, inline browser
rendering, object URLs, SVG/PDF support or write authority. A source that cannot
provide the optional binary seam remains a first-class fallback rather than widening
the capability contract.

## D49 — Remaining Canvas authority rows stay explicit scope decisions

Gate 8 does not add durable external-file grants or directory sources. Those would
require persistent permission, rebinding, recursive enumeration and containment
semantics beyond the ephemeral one-shot browser File contract. Source SVG remains
passive by policy because it is active-capable content, and PDF rendering remains
optional/not added. These are deliberate boundaries, not implicit capabilities.

## D50 — Owner mode is the product destination; read-only is the bootstrap

The signed read-only release remains the safety substrate for the owner-authorized
vault agent. Gate 13 now builds a generic byte-based conditional mutation engine over
memory and disposable roots; it does not grant creator-vault writes. Final owner mode
is intentionally programmatic and supports create, update, rename/move, delete and
recovery after bounded authority, conflict, audit, native restoration and Obsidian
coexistence gates pass. Initial enrollment may require one unavoidable OS/browser
gesture, but acceptance and normal operation must not require recurring UI clicks.

## D51 — Native FSA write authority is a fail-closed no-go

**Decided:** browser File System Access has no compare-and-swap or conditional-replace
primitive. A second JavaScript revision read cannot close the check-to-commit window
against Obsidian or another writer, and the 13D2 race demonstrates that this window is
observable. The native adapter therefore remains read-only; `evaluateFsaWriteBoundary()`
returns a bounded `BLOCKED` report with reason `fsa-no-compare-and-swap`, and no FSA
writer is exposed.

**Boundary:** Gate 13.3 is closed as a safety decision, not as a claim that native
writes are safe. Reopening it requires a Papers/native transaction capability that
atomically validates the observed revision at commit, plus a fresh acceptance run.

## D52 — Durable owner authority is explicitly read-only in this build

**Decided:** the owner boundary is scoped to an explicitly supplied exact root and
restores only read authority. Prompt/denied/revoked permission remains machine-readable
and blocked; the browser never discovers a vault or silently upgrades a handle. The
`evaluateOwnerAuthorityBoundary()` report is therefore `BLOCKED` with
`native-fsa-grant-and-transaction-required`, and no per-operation picker or write
confirmation is implied.

**Boundary:** Gate 14 is closed as a read-only capability decision. Creator-vault
writes require both an explicit enrollment flow and the stronger native transaction
primitive required by D51; until then, the safe autonomous behavior is bounded reads,
refresh, coexistence observation and fail-visible refusal of writes.

---

## D53 — Unsupported-but-recognized frontmatter is generation-acceptable

**Decided:** `unsupported-frontmatter` means the parser recognized a YAML construct
outside Proxima's interpreted subset and deliberately left the affected key unset. It
is a warning, not a generation-rejection condition, both on initial load and on
refresh. `frontmatter-parse-failure` remains a distinct refresh-blocking condition.

**Why:** identical vault bytes must not be acceptable at startup and then become
unacceptable solely because they were encountered during refresh. The parser already
protects interpretation by refusing to guess, preserving the raw frontmatter and
reporting the unsupported construct. Rejecting the whole refreshed generation would
also discard unrelated supported edits even though the unsupported region was handled
exactly as it was during initial load.

**Boundary:** acceptance does not make the unsupported value understood and does not
license serialization from the lossy interpreted projection. The affected key remains
unset/defaulted exactly as before, the structured warning remains visible, and the D7
source-preservation requirements still govern any later writer. In the current
record-store-precutover build, all eventual mutation paths remain unavailable.

---
## D54 — HARD GATE B uses Proxima's Backpack-origin OPFS

**Decided:** the Proxima-owned canonical Record Store lives in the Origin Private File
System belonging to Proxima's stable Papers Backpack origin:

`papers-backpack://bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1`

Proxima reacquires that origin-private root programmatically with
`navigator.storage.getDirectory()`. Beneath the root it owns one fixed namespace:

- `record-store/records/` — the already-defined opaque RecordStore JSON filenames only.
- `record-store/recovery/` — the durable recovery-journal representation when Stage 7
  wires the already-required recovery semantics.

The Chromium/Electron implementation path beneath Papers' persistent profile is not a
Proxima path contract. It is never discovered, accepted from a semantic caller,
persisted as canonical data, or exposed through inspection or agent actions.

**Why:** Papers already gives each independently maintained Backpack a stable secure,
standard origin keyed by exact Backpack ID. The real Proxima Papers surface has already
proven OPFS availability and disposable OPFS round-trips. The packaged Papers profile
is persistent across ordinary application restarts. This location therefore supplies
a Proxima-owned filesystem namespace without selecting a creator directory, putting the
canonical database in the Obsidian vault, or adding a Papers storage/transaction
capability.

**Authority restoration:** OPFS authority is reacquired from the stable origin on every
bootstrap by calling `navigator.storage.getDirectory()` and opening the fixed
`record-store` children. No `showDirectoryPicker()`, external persisted handle,
absolute path or recurring creator gesture is part of this store. Failure to reacquire
the OPFS root is a blocked/unavailable store condition; it must never trigger a silent
fallback to the creator vault, project checkout or another location.

**Agent boundary:** raw OPFS roots, directory handles and file handles remain private to
the Proxima storage adapter. Human and agent mutation callers continue to meet only at
the typed Proxima semantic action layer. No generic backing-store action, pathname
action or direct agent JSON access is introduced.

**Restart boundary:** this decision settles the physical location/API; it does not
pretend that the Stage 7 implementation already exists. The separate `Restart retains
records` acceptance row remains open until an implemented OPFS backend proves a write,
normal Papers exit/relaunch and exact reread under the same Backpack origin.

**Recovery boundary:** the recovery journal is colocated in the same origin-private
`record-store` namespace, under `recovery/`, so it has the same lifecycle as the record
files. This decision does not define a new journal format or wire the mutation
coordinator; Stage 7 must reuse the already-required recovery semantics.

**Concurrency boundary:** choosing OPFS does not close the multiple-Proxima-callers
rows. No last-write-wins behavior, locking mechanism or retry policy is selected here.
Those requirements remain explicit Stage 7 work.

**No host expansion:** this decision requires no Papers modification and does not claim
H4. Creator-vault FSA remains separate and read-only under D51/D52.

**Reverses if:** implemented acceptance proves that the stable Proxima origin cannot
retain this namespace across a normal Papers restart, or that OPFS cannot support the
later required crash-durability and coordinated-writer contract. In that case HARD
GATE B reopens before any real import; there is no silent fallback location.

---

## D55 — The UI reaches record mutations through the operation layer, not the dispatcher

**Decided:** a surface gesture that mutates a record calls the semantic operation layer
directly — the Elastic drop calls `moveTaskByGesture`, which validates, writes through the
recovery coordinator and then re-reads the source. The registered action dispatcher keeps its
typed refusal for every record-mutation action type and continues to hold no store authority;
`task.execution.move` is no longer dispatched by the shell at all, because a rejection the
reader never experienced would be a false entry in the event ring that Stage 17 audits.

Both callers still meet at one operation: the gesture and an agent caller reach the same
`createTask`/`updateTask`/`deleteTask` functions with the same closed typed mutation union, and
the same typed refusal vocabulary (`validation-refused`, `not-found`, `stale-revision`,
`semantic-conflict`, `recovery-required`, `storage-failure`) comes back to either. What the
dispatcher owns today is presentation and navigation plus the typed-unavailable contract that
keeps record mutations unreachable while the store is not activated.

**Why:** the dispatcher is a synchronous function over in-memory state, and a record mutation
is an asynchronous durable write behind a recovery gate. Making one call the other would either
give the shell store authority — which the containment guard exists to prevent and which
`d6e2b30` removed — or force a promise through every existing dispatch site. The operation
layer already speaks the taxonomy's names for what a gesture *is* (`task.execution.move` versus
`task.execution.reorder`), which is the vocabulary the parity and coverage audits read.

**Reverses if:** `actionProtocol` gains an asynchronous, injected record-mutation executor — an
authority the shell passes in rather than holds — at which point the gesture should be routed
through the dispatcher so there is exactly one semantic entry point for a UI caller and an
agent caller.

---

## D56 — Project deletion is refused until the creator says what it means

**Decided:** `project.delete` is implemented as a **deterministic typed refusal** — reason
`policy-not-decided`, a sentence naming how many tasks and events the project holds, and no write of
any kind — while `project.create`, `project.update`, `project.archive` and `project.restore` are
implemented in full. The refusal is the same for every caller, because there is one operation
(`src/app/projectMutations.ts`) and the UI and an agent both meet at it.

**Why:** the checklist says in as many words that this is an open semantic question and that the
source cannot answer what the creator wants after the old storage model was removed. It lists three
possible answers — leave members uncategorised, require an explicit cascade, or refuse while members
exist — and each one changes what a click means, what an agent's request means, and what a user is
promised. Implementing any of the three would be inventing a product decision, and a silently
plausible choice is worse than a refusal: a cascade that ran would be unrecoverable, and a delete
that left records behind would look like data loss to whoever found them later.

Two things are deliberate about the refusal itself. It is **deterministic** — the same request
refuses with the same words, so it is a contract rather than a shrug — and it is **informative**: it
names the member counts, so the person who owns the question can answer it from the message. An
empty project is refused for the same reason and with the same reason code as a full one, which is
what makes the eventual answer a decision rather than a side effect of how many tasks exist.

**Also decided, and implemented:** archiving is a **status change and nothing else**. It sets
`status` and `archivedAt` on the project and does not consult, move, mark or count its members; the
test asserts every member record is byte-identical afterwards. An archive that touched a task would
be a delete wearing another word.

**Reverses if:** the creator answers the question. If the answer is "refuse while members exist",
the refusal stays and its reason changes to a policy one that a caller can act on; if it is
"cascade explicitly", a new operation is added that takes the members as an explicit list rather
than inferring them; if it is "leave members uncategorised", the delete proceeds and the members
keep a project id that no longer resolves, which the projection already reports as a gap rather
than dropping. Whichever it is, `deleteProject` is the one function that changes.

---

## D57 — The lifecycle controls are enabled by a resolved write path, and Delete is enabled with them

**Decided:** the Projects Hub draws Archive, Restore and Delete as **real controls** whenever a
record write path has resolved (`projectWrites.refusal === null`), and as disabled controls carrying
the reason beside them when it has not. Delete is offered on exactly the same terms as the other two.
Its refusal — `policy-not-decided`, with the member counts — is drawn as a sentence where the button
is, and the button stays enabled, because that refusal is an **answer** rather than a missing feature.

**Why:** the earlier stance — "Unavailable until record-store cutover", hardcoded in the renderer —
was honest only while *no* lifecycle verb could run. Once four of the five run, a disabled Delete
would say about it the same false thing the banner used to say about all of them, and it would hide
the one message that lets the creator answer D56's question. The distinction the surface now draws is
the real one: `refusal === null` means "there are operations behind these buttons", and the feedback
line carries whatever the last attempt said — an accepted outcome's sentence, or the operation's own
refusal with its code and detail together.

**Also decided:** the feedback line is drawn **twice** — once inside the controls it belongs to, and
once at the list level. Archiving is the case that forces it: the archived card leaves the active
list, so a sentence drawn only on the card would vanish at the exact moment it became the only thing
explaining what had happened.

**Reverses if:** the deletion policy is answered (D56), at which point Delete's sentence changes and
nothing about its enablement does; or a surface appears that can write records but not projects, in
which case the option becomes per-verb rather than one `ProjectWriteView` for all three.

---

## D58 — A refused form keeps what was typed, and the project editor offers exactly two fields

**Decided:** both project forms — New Project and the project editor — hold their values in the
**shell**, not in the DOM. The New Project draft (`projectCreateDraft`) is set before the write is
attempted and cleared only when it is accepted or cancelled; the editor holds a `ProjectEditorDraft`
built from the record when it opens (`src/app/projectEditor.ts`). A refusal is drawn *on* the form
with the operation's code and sentence, the form stays open, and the values stay where the reader put
them. The editor offers `name` and `description` and nothing else.

**Why:** the draft rule was found by a test rather than chosen in advance — a case asserted that a
refused save left "Kept while refused" in the box and the box was empty, because the refusal was
shown by re-rendering and the values only ever existed in the DOM. A form that discards a reader's
typing in order to tell them why it could not save makes them type it again to fix it, and it makes
the refusal look like a reset. Holding the draft also makes "what changed" a computation over two
values rather than a reading of the DOM: only the changed fields are submitted, and a save with
nothing changed is the operation's own `validation-refused` — asserted with the record's revision
unchanged, because a record rewritten to say the same thing is a write nobody asked for.

**Also decided:** `projectType` is not offered by the editor. A4 removed that legacy label from
capability decisions, so a form that could set it would be reintroducing the silo the stage removed;
`project.update` cannot express it either, which makes the two agree by construction rather than by
discipline.

**Reverses if:** a project field is added that a reader must be able to edit (the editor's union
grows, and the migration is a `ProjectFieldMutation` case); or the surface gains an autosave model, in
which case the draft becomes a debounced write and this decision's "only what changed" rule matters
more, not less.

---

## D59 — A move and a resize are their own verbs, snapping is the gesture's, and dates are validated once

**Decided:** the event write path is five operations in `src/app/eventMutations.ts` —
`event.create`, `event.update`, `event.delete`, `event.reschedule` and `event.resize`. A reschedule
names the new **start** and the operation takes the duration from the record; a resize names either
the new **end** or a **duration** in minutes, never both and never neither. The dates are *not* in
`event.update`'s field union. Gesture geometry lives in `src/app/eventGesture.ts`, which turns a
pointer delta into the same request those verbs take, and **snapping to fifteen minutes lives there
and only there**.

**Why three rules rather than one update verb.** An agent asked to *"move event E to 2026-09-10
14:30, retaining its current duration"* should be able to say exactly that, and a drag should compile
to the same thing — so the duration belongs to the record, not to the caller, and neither caller
computes an end. A resize is the mirror image: the start stays and the caller names what it knows,
which for a gesture is where the bottom edge landed and for an agent may be "90 minutes". The
alternative — one `event.update` with a `dates` mutation — would have made every caller reimplement
"keep the duration" and would have made the two checklist verbs (`event.reschedule`, `event.resize`)
names without referents.

**Why snapping is not in the write path.** A gesture can only mean a slot boundary, so rounding a
pixel delta to whole slots is what makes a drag feel like a drag. An agent asking for 14:37 means
14:37. Putting the rounding in the operation would silently rewrite agent requests to the nearest
quarter hour, which is the class of "the write path decided something for you" that this tree keeps
refusing. The two layers share one arithmetic: the provisional block and the request are computed by
the same function, so what a reader sees while dragging is what will be written, and a drag that
moved nothing sends no request at all.

**Why validation is once, in the operation.** A start and an end must both be real instants with the
end strictly after the start — a zero-length event is a point, not a span. The gesture refuses a
resize that would leave no duration *before* submitting, because "invalid duration refused before
storage" is a promise about what leaves the gesture; the operation refuses the same thing with the
same vocabulary, so the two agree rather than merely coexisting.

**Also decided:** `event.update` carries `name`, `description`, `project`, `completion`, `recurrence`
and schema-keyed `property` mutations — the same closed-union style as `task.update`, with a property
whose key names no schema record refused as a semantic conflict rather than written as a field
nobody defines. Recurrence *series* semantics (this occurrence versus the whole series) are Stage 13's
and are not invented here.

**Reverses if:** Stage 13 needs occurrence-scoped writes, at which point `reschedule` and `resize`
gain a scope parameter rather than a second operation; or a gesture appears that must express a
non-slot boundary (a five-minute grid, a free-form timeline), at which point snapping moves to the
grid that knows its own resolution.

**Amended while writing the form** (slice 69, the same stage): `event.update`'s field union *does*
carry a `span` mutation — both ends together — because the Event editor shows a start and an end and a
reader who fixes both is describing one new span, which neither `reschedule` (one end, duration from
the record) nor `resize` (one end, start from the record) can express. The original reason still
holds where it mattered: there is one validated span rule and one write, shared by the two gesture
verbs and the form's mutation, so the three cannot disagree about what a span is. What the amendment
rejects is only the idea that a form should have to send two writes to say one thing.

---

## D60 — Deleting a project is an explicit two-step cascade

**Decided:** the answer to D56 is *requires explicit cascading action*. Deleting a project that still
holds members becomes **two steps**: the Hub's first Delete reports what the project holds and asks,
and only a confirmed second step removes the project together with the members the reader was shown.
The members travel as an **explicit list in the request** (`project.delete` gains a cascade list) rather
than being inferred from the store, so a list that no longer matches what the store holds is refused
instead of acted on — a stale first step can never delete a record the reader never saw. Deleting an
empty project stays one step, because there is nothing to confirm.

**Why:** the three possible answers in D56 were left to the creator and this is the one they chose. An
explicit list is what makes "two step" mean something at the operation as well as at the surface: a
`cascade: true` flag would put the inference back inside the write path, which is the thing being
avoided, and the reader's confirm step and the request's member list are then the same fact rather
than two descriptions of it that can drift.

**Reverses if:** the creator later prefers a single-step delete with an inline confirmation, at which
point the operation takes the members from the store and the refusal for a mismatch is dropped; or if
members are to survive their project, in which case the cascade list disappears and the projection's
existing dangling-project gap becomes the ordinary case.

---

## D61 — Proxima has no tag model

**Decided:** *no tags*. Tag filtering is not a Proxima feature and no tag field, tag column or tag
filter will be added. The Backlog's filtering stays what it is: field filters over the record's own
fields, and property filters over schema-keyed custom properties. A `tags` list is not a canonical
field, and inventing one to satisfy a filter box would be adding a data model to the product to fill a
checkbox.

**Why:** the creator answered the product question the box was waiting on. Proxima's organising
concepts are projects, execution state, the project workflow and custom properties; a tag list would
overlap all four without being any of them, and a filter is not a reason to add a concept.

**Reverses if:** the creator asks for tags, at which point they are a schema-shaped concept of their
own and get a definition, a column and a filter like every other property rather than a special field.

---

## D62 — Task recurrence is retained

**Decided:** *yes* — a task may repeat, exactly as an event may. The record layer already accepts a
`recurrence` series for a task (the mutation kind exists and is exercised), so this decision settles
what was genuinely open: whether the concept survives at all. It does. What is still missing is a
surface — the Task editor has no repeats control, and the checklist's coverage row for task
recurrence therefore stays declared **operation-only**, with the audit asserting that no caller exists.
Wiring a control that reaches the existing mutation is ordinary work now rather than a question.

**Why:** the creator answered. Retaining it also keeps tasks and events symmetric: both are canonical
records with a recurrence series, and the Event editor's this-occurrence/series scope modal is the
pattern a Task editor control would follow rather than a new one to invent.

**Reverses if:** the creator drops task recurrence, at which point the mutation kind is removed and the
coverage row becomes an absence assertion rather than a declared gap.

---

## D63 — Artifacts and vault files stay read-only; the writer question waits behind the UX

**Decided:** *read-only*, for now and deliberately. Proxima does not create, rename, move, delete or
attach vault files: the workspace's Notes tree, its previews and its navigation are the read half, and
the file-write actions named in the checklist are **not offered** rather than half-offered. The creator's
intent is that Proxima eventually becomes a writer — and their instruction for the present pass is to
get the UX right first — so the destination and authority question (whose directory, under whose
boundary) is deferred rather than answered by implication.

**Why:** the checklist's three candidate answers all change what `artifact.move`, `artifact.rename` and
`artifact.delete` mean and where they may reach, and `VaultWriter` cannot be the answer by itself:
native browser FSA has no atomic compare-and-swap commit, so `evaluateFsaWriteBoundary()` fails closed
and no FSA writer is exposed, while `evaluateOwnerAuthorityBoundary()` grants read authority only.
Shipping a file gesture on that foundation would be the silent last-writer-wins behaviour this tree
exists to refuse.

**Also decided, and already asserted:** file-write operations may be implemented and tested on
disposable roots, Notes/files read parity can close, no native shared-vault rename/move/delete may be
declared fully safe merely because record JSON is journaled (HARD GATE D's standing position), and H4
remains unclaimed until the creator explicitly chooses it.

**Reverses if:** the creator names a destination — files under Proxima's own record-store root, or an
explicitly granted creator directory with its own authority boundary — at which point the artifact
operations gain that destination as their meaning, the surface gains the gestures, and this decision is
amended rather than deleted. The creator has said they want a writer *eventually*; this records the
order, not a refusal in principle.

---

## D64 — Gantt row placement is a third durable order scope

**Decided:** the creator declares row placement **semantic**, so it gets its own scoped durable field,
in the same shape as `executionOrder` and `workflowOrder`: a canonical field on the task, one typed
`task.update` mutation that writes it, a projection that carries it into the readable world, conflict
behaviour identical to the other two orders (the revision the surface was rendering, a lost race
reported with the revision that beat it), and its own row in the action-coverage audit. A3 named this
case in as many words — "any durable user-authored ordering elsewhere" — so the model already has a
place for it; nothing about the existing two scopes changes.

**Why:** the preferred correction (row layout as local state) was the tree's working assumption, not a
creator decision, and the creator has now decided the other way. The cost is real and recorded here so
nobody is surprised by it later: a third order can drift from the board and the workflow, two writers can
race over a row order, and legacy import has to map or default the old plugin's row placement. What the
answer buys is a Gantt whose arrangement is authored rather than derived — persistent across reloads,
windows and agents, and independent of the Elastic queue.

**Open sub-question, and the proposed answer.** A durable order needs a scope, and the three candidates
are visible to the reader: one global row order, one per project, or one per saved view. The proposal is
**one global order**, because the Timekeeping Gantt is a single global surface rather than a
project-scoped one — a per-project order would have to be interleaved whenever the Gantt shows more than
one project, and a per-view order has no view to belong to until saved views exist. This is the one part
of D64 the creator has not been asked about; the slice should confirm it before the field is added, since
changing the scope later means migrating rows rather than editing a rule.

**Amended while unblocking the work** (the creator instructed the pass to proceed without further
questions rather than wait): the scope is taken as **one global order**, which is the proposal above.
It is reversible with no migration until the field ships — before the row order exists in any record,
changing the scope is editing a rule; after it ships, the same change is a data migration, which is why
this is written down as an assumption the working slice carries rather than a question left open.

**Reverses if:** the creator prefers local state after seeing the drift, at which point the field is
removed and rows are derived again; or the scope answer is per-project or per-view, which changes where
the position lives and what a reorder means when the Gantt is filtered.

---

## D65 — The importer preserves what it cannot map, and reports it

**Decided:** the answer to Stage 8's question is **preserve and report**. Legacy frontmatter that does not
map to a canonical field is never dropped, rewritten or "normalised away": the source keeps its bytes,
and the import report names every such field as a problem with the record it belongs to, so the reader
sees exactly what Proxima did not understand rather than discovering it later as missing data.

**Why:** preservation is already this tree's habit — `sourcePreservingMarkdown` exists so that reading
and writing a Markdown source cannot silently reformat it, and the byte-preservation verifier proves the
claim against real trees; the import planners already separate what they can stage from what they must
report. Reporting rather than refusing also keeps a migration possible: a vault with one odd field should
import with a note, not fail as a whole.

**Reverses if:** the creator prefers dropping unmappable fields with a report (which changes what a
re-export means, since the data would no longer be there), or refusing that record's import (which makes
one odd field block a whole vault).

---

## D66 — A box closes on tested logic, with its residual stated

**Decided:** the closure standard for this pass is **tested logic**: a box closes when the behaviour it
names is covered by a code path plus a test, or by a written decision in `docs/`. Where the capability is
not reachable in the running app — because it waits on HARD GATE C's shipped trigger, on an agent write
path, or on a surface that does not exist yet — the tick says so in as many words instead of leaving the
box open for in-app reachability, and the residual names what would make it reachable.

**Why:** it is what the pass has actually been doing, and the creator has confirmed it. Making it explicit
is what stops the standard drifting per agent: "probably true" stays unticked, a decision is a legitimate
close when the box asks a question, and a reachability gap is disclosed rather than hidden or used as a
reason to leave a box open forever.

**Reverses if:** the creator wants the stricter standard — nothing closes until a reader can reach it in
the running product — at which point the boxes ticked on tested logic alone are re-opened with their
residuals promoted to blockers.

---

## D67 — The canonical cutover is never automatic: activation is explicit, one-time and user-invoked

**Decided** (the creator delegated this choice, and it is made here rather than left open): the shipped
default stays the **legacy Markdown reader**, and the canonical record store becomes the source of truth
only through an **explicit, one-time activation** that no ordinary boot performs on the reader's behalf.
Once a store has been activated, the legacy Markdown record directories are **legacy source only**: they
remain present, they are never read as canonical while the store is the source, and nothing deletes them.
This is the trigger HARD GATE C's two remaining boxes were waiting for, so they close as statements about
the activated configuration rather than as pending work.

**Why this way.** Three reasons, in order of weight. First, the creator's own standing answer is read-only
now with the writer intended later (D63), and a first-launch cutover opens the one-way door — the vault
reads empty until the import runs, and after it an edit made in Obsidian no longer reaches Proxima — before
the question that door belongs to has been answered. Second, blast radius: explicit activation is
reversible in the only sense that matters here, because nothing is migrated, moved or deleted until
someone asks for it, while an automatic cutover changes what the product *is* on first run for a live
vault that may contain years of records. Third, honesty about the state of the tree: the import's commit
path, the activation marker, the projection and the isolation of legacy edits are all built and tested, so
the gate is about *shipping* the cutover, and shipping it behind an explicit act is the version that cannot
surprise its owner.

**What this does not decide:** whether the ordinary UI should *offer* activation (a control, a first-run
prompt, an import screen). That is a smaller, separate affordance question, it is not what HARD GATE C is
about, and answering it is ordinary work the day the creator wants the cutover reachable by hand rather
than by an explicit administrative action. Until then, activation is performed deliberately and the
default is the reader everyone already has.

**Reverses if:** the creator asks for the cutover on first launch, at which point an ordinary boot offers
the one-time import and activates on success — and this decision is amended, not deleted, because the
statements about the activated configuration stay true either way. It also reverses if a shipped build
must activate because the legacy reader is being removed; that would be a different decision with the same
consequence for the one-way door.

## D68 — Templates carry no relative-date forms, so date interpretation is not clock-dependent

**Decided** by the browser AUTHOR on 2026-09-12, while scoping Stage 16's executor, and asked for plainly
rather than inferred: template `start` and `deadline` accept only the parser's existing absolute-date
grammar. No `today`, `tomorrow`, `+3d`, `-1w`, `next-monday`, and no deadline computed from a relative
start. Nothing in Stage 16 therefore depends on which day the clock says it is, which timezone decides
"today", or what happens across a month or year boundary, because there is no such computation to get
wrong.

**Consequence in the code:** `executeTemplatePlan` takes no clock at all. The first version of it accepted
one as an injected dependency of the stage, unused, on the theory that the seam should exist before the
feature; the AUTHOR rejected that, and the parameter was removed rather than left as an intentionally dead
argument. A template's dates are the text the author wrote, validated by the parser.

**Reverses if:** a creator-facing template form for relative dates is asked for. It would arrive as a
parser change first — a typed relative-date form in `TemplatePlan` — and only then as clock-dependent
resolution in the executor, with the boundary cases that decision names.

## D69 — The manual-versus-template equivalence is judged on records, not on requests

**Decided** by the browser AUTHOR on 2026-09-12, answering whether the Stage 16 equivalence box closes at
the request level or the store level: **store level**. Equal request lists prove compilation parity, while
the claim in the checklist is about the records that result, so the acceptance compares decoded canonical
task-record multisets from two isolated runs — one manual, one through template execution — after
normalising away `id`, `createdAt` and store/observation revisions. Every semantic field stays compared:
project, execution state and order, dates, durations, completion, properties and recurrence.

**Consequence:** deterministic ids and a fixed clock may make a test convenient, but the acceptance must
not depend on coincidentally identical generated identity or timestamps; the normalisation is what carries
that weight. The test's seam is `MemoryRecordFiles` from `tests/test-record-store.ts` wrapped by
`createCanonicalJsonRecordStore`, driving the real `createTask` path the way `tests/taskMutations.test.ts`
does.

## D70 — Stage 17's "UI invocation test exists" needs a runtime click, not a source reading

**Decided** by the browser AUTHOR on 2026-09-12, **rejecting the executor's earlier tick** of that box. The
executor had produced the two halves this repository can produce today - `tests/templateExecuteWiring.test.ts`
renders the panel while bound to exactly the options the shell passes, and reads the shell composition as
source - on the reasoning that `src/browser/main.ts` runs its composition on import and so cannot be
imported by a test (`tests/acceptanceTools.test.ts` records that). The AUTHOR's ruling: *"reading main.ts as
text cannot prove the listener actually invokes the action under runtime composition."* The two halves are
wiring evidence; they are not the box.

**What closes it instead** — named by the AUTHOR, and explicitly not a second general harness: extract the
template execution binding from `main.ts` into an importable `src/browser/templateExecuteBinding.ts`, have
`main.ts` use it, then render the real panel, bind that module, click the stable key the renderer already
supplies (`data-c1-key="template-execute"`) through the **existing** `InteractionHarness`, and observe
`executeTemplateAction` together with the running/result state. The box stays open until that exists.

**Consequence:** the unimportable shell is not an excuse for source-shape evidence on a box that asks for a
click; it is a reason to move the binding into a module a test can import. `tests/actionCoverageAudit.test.ts`
keeps the row honest while the box is open, and the equivalence column below (D71) inherits the same
requirement, because it compares the two callers of this chain.

**Reverses if:** the click test lands, or the AUTHOR accepts a different mechanism that exercises the real
listener. The reasoning about *why* the two halves are insufficient is not reversed by either: source text is
not runtime composition.

**Applied at `a983b9a`** (2026-09-12): `src/browser/templateExecuteBinding.ts` holds the binding, `main.ts`
composes it and keeps no branch of its own for the verb, and `tests/templateExecuteClick.test.ts` drives the
real listener into a real store. The checklist box stays unticked until the AUTHOR checks that evidence,
because the EXECUTOR does not accept its own work.

## D71 — A UI/agent equivalence is asserted through the shipped entry, and between the two callers

**Decided** in two steps on 2026-09-12. The executor found the Templates equivalence case driving
`executeTemplatePlan` - one layer below both shipped callers, which go through `executeTemplateAction`, the
entry that parses the template text itself so no caller can execute a hand-built plan - and moved the
comparison up to the action, keeping D69's record-level judgement unchanged. **The browser AUTHOR ratified
that boundary**: comparing through the action is what proves equivalence through the shipped layer, and the
executor keeps its own coverage in `tests/templateExecution.test.ts`. It then **narrowed the claim**: the
Stage 17 matrix box sits beside *agent invocation* and *UI invocation*, so its natural claim is equivalence
**between those two callers**, not between the manual path and the template path. That case answers Stage
16's box - where it stays, ticked - and the matrix box was reopened.

**Consequence:** the matrix box closes on two isolated worlds - a UI click and a `submitTemplateExecution`
submission, same template and project - compared on outcome and partial semantics plus the normalised
resulting records. It cannot be closed before the UI chain is clickable, so it depends on D70's extraction
rather than merely following it. `tests/templateEquivalence.test.ts` keeps supplying the action's
dependencies structurally (the operations, surface hooks that record rather than draw, and a refresh that
declines - a state the action already answers with `refreshed: false`).

**Reverses if:** the action stops being the single entry (a second caller with its own translation would
reopen the boundary question), or an equivalence claim is genuinely about the executor's contract - in which
case it belongs in the executor's suite **as well as**, never instead of, the record-level cases here.

**Applied at `a983b9a`** (2026-09-12): `tests/templateCallerEquivalence.test.ts` runs the same template
through a click and through `submitTemplateExecution`, in two isolated stores, and compares what each caller
reports and the normalised resulting records, with a control that would notice a difference. As with D70, the
checklist box stays unticked until the AUTHOR checks the evidence.

## D72 — `template.execute` is a sibling entry, not a `ProximaAction`

**Decided** by the browser AUTHOR on 2026-09-12, when Stage 16's agent path was registered. The protocol's
`dispatch()` is deliberately synchronous and generates its own request id, and the action union's guarantees
are written for single-record, single-effect verbs. A template run is neither: it is asynchronous, it can
create several records, and it can stop part-way with some of them already durable - so forcing it through
`dispatch()` would either change the execution model of every unrelated action or quietly make the union's
promises untrue for one member.

**What it is instead:** a sibling entry with its own wire shape. `src/app/templateSubmission.ts` validates the
outer shape (`{ type: 'template.execute', template, projectId? }`), refuses a malformed submission with a
sentence, and hands the work to `executeTemplateAction` - the same action the panel's Execute reaches through
`src/browser/templateExecuteBinding.ts` (D70). No caller-supplied request id and no hand-built plan: the entry
accepts text, and the text is parsed inside the action.

**Consequence:** the dispatcher's union does not learn a template verb, and `tests/actionCoverageAudit.test.ts`
asserts that it stays out - a row that named a sibling verb in the union would be claiming guarantees that
were never designed for a run of variable length. The cost is that a template run is not correlatable through
the protocol's own request id, which is one of the two gaps the Stage 17 matrix records for this row.

**Reverses if:** the protocol grows an asynchronous, correlation-carrying dispatch whose contract covers
multi-record runs. That is exactly the subject of the cross-cutting request-id slice the matrix's gaps point
at, so this decision is expected to be revisited there rather than left standing on a technicality.

## D73 — The agent write path is a sibling entry over the operation, and a wrapper does not reshape a result

**Decided** on 2026-09-12, working the checklist's agent-parity gaps with the browser AUTHOR retired: three
open boxes (Stage 0's UI/agent equivalence over the action protocol, its Evidence counterpart, and Stage 19's
convergence and race boxes) all named the same missing thing — an agent-facing submission path. Nothing on the
agent side could write a record: the loopback bridge is a read-only vault reader, and the dispatcher refuses
every record verb with `action-not-available` before the record layer.

**What it is:** `src/app/agentWritePath.ts`, a sibling entry on the pattern D72 fixed for templates. Its wire
names a semantic verb and the facts the agent read — `{ type, taskId, from, to, targetIndex,
expectedRevision }` — and hands the work to `moveTaskByGesture`, the operation the Elastic drop wrapper and
(through it) the shell already reach. Four consequences follow from that shape, and each one is asserted rather
than intended:

- **A verb enters the wire only when its operation runs with no cockpit.** `task.execution.move` and
  `task.execution.reorder` qualify; every other verb the taxonomy registers as a record or artifact mutation is
  answered `unsupported-verb` with a sentence naming where it belongs. The set is derived from
  `registeredActionTypes()` and `categoryOf()`, so a newly registered record verb cannot be silently unknown to
  the wire. One of the two accepted verbs, `task.execution.reorder`, is not in the protocol's registry at all:
  the registry carries what `parseAction` accepts, and a reorder arises from a gesture rather than a dispatcher
  input. The wire speaks the operation's vocabulary, which `taskMoveActionType` owns.
- **The revision is a required field and the wire never guesses one.** An agent that lost a race is refused
  `stale-revision` with the revision that beat it, in the same words the UI's path uses.
- **The request id is minted before the submission is parsed**, so a malformed or unsupported submission is
  journalled with the id its own refusal names — the convention `dispatch` already follows, where the id exists
  before `parseAction` is asked. A caller-supplied `requestId` is ignored.
- **A declared verb that contradicts the record facts is refused, not corrected.** A drop from `running` to
  `running` *is* `task.execution.reorder` by `taskMoveActionType`'s rule, and a submission that calls it a move
  is told which one it is; silently renaming the operation would journal a verb the caller did not ask for.

**The companion change, and why it was necessary:** `performElasticDrop` used to reshape the gesture's result
into a narrower, surface-facing summary. A parity claim between two entries cannot be judged against a subset
of fields — a divergence can hide in the fields one side drops — so the wrapper now returns the gesture's
result untouched and adds only the two refusals it decides itself, in that same shape. A wrapper's job is the
wiring and its own refusals, not a second vocabulary for one operation. Its pre-gesture refusals name the
family `task.execution.move`, which is what its own audit event already said, because the column the card is in
is exactly what is missing when the board cannot show the card.

**The containment rule is untouched.** The dispatcher still refuses every record verb, the bridge is still
GET/OPTIONS-only read transport, and `tests/agentWritePath.test.ts` asserts both facts in the same file that
proves the wire works: an agent gains a record write, not a vault capability. Creator-vault write authority is
unchanged.

**One vocabulary fact recorded rather than smoothed:** an id that is not a canonical record id comes back from
the record layer as `storage-failure` — the store refuses to read it and the layer maps a refused read to that
reason — while a canonical id that is simply absent comes back as `not-found`. The wire reports both unchanged.
Re-mapping that belongs to the record layer, not to a wire, and is not this slice.

**Reverses if:** the protocol grows an asynchronous, correlation-carrying dispatch that can run record verbs
against an observed revision — then this wire should fold into it rather than stay a sibling. Until then the
alternative to a sibling entry is loosening `action-not-available`, which the containment and coverage suites
exist to prevent.

