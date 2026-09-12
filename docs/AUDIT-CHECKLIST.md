# Proxima Backpack — Incremental Audit Checklist

This is the project agenda and the durable record of where it stands. It is kept in
the repository on purpose: the checklist is the contract each pushed SHA is audited
against, so it must travel with the code rather than living in a conversation.

## How this document is maintained

- Every gate is **independently auditable**. Later gates are not bundled into earlier
  ones unless they are mechanically inseparable.
- A box is ticked only when the behaviour it names is covered by code plus a test, or
  by a written decision in `docs/`. "Probably true" stays unticked.
- Each slice is pushed on its own and audited before the next begins. The audit
  question is always:

  > "Does this SHA satisfy this gate, and is there any concrete correctness,
  > architecture, security, compatibility, determinism, or data-safety blocker
  > before the next gate?"

  Never a broad "looks good?" review once implementation begins.
- Every push reports: exact SHA, branch, intended gate, files intentionally changed,
  tests run with exact totals, build/typecheck result, whether Papers changed, any
  dirty/user-owned files not to touch, known limitations, and the exact acceptance
  claim being audited.

## Owner-mode automation rule

The final product is an owner-authorized autonomous vault agent. After initial owner
enrollment, no implementation or acceptance gate may require the creator to return to
the UI to click a button, select a folder again, trigger refresh, approve an
individual operation, or manually transcribe evidence. Initial enrollment may require
one explicit creator action where the operating system makes that unavoidable; it is
setup, not recurring operation. Durable authority must restore across normal
Papers/app restarts, and all later tests must drive machine-readable programmatic
contracts. A gate is never solved by instructing the creator to “click X and report
back.”

## Current status

| Field | Value |
| --- | --- |
| Current slice | **The agent wire runs seven families, and the seventh has its own entry because it does not answer `ok`, at `TBD`.** `task.timeline.change` joined the drop pair and the schema family, and it joined them by the rule rather than by exception: `src/app/timelineChangeAction.ts` now holds `changeTaskSpan`, an operation whose dependency set is the write, the refresh, the id source and the event sink - no projection, no refusal sink, no render - so the record facts it used to read are parameters (`expectedRevision`, and the span as the caller read it). `changeTaskDatesAction` remains the cockpit's entry over that operation. The submission carries the whole span for every gesture, which removes a malformation rather than validating one: a resize that named one end and took the other from the projection is not a shape a caller without a projection can express. The workflow-stage sequence joined them the same way at this commit: `runStageWrite` in `src/app/workflowStageWriteActions.ts` now takes the write, the refresh, the id source and the sink, with the one fact it used to read from the board - a stage's revision - supplied as a lookup the caller owns, so `workflow.stage.create` and `workflow.stage.rename` are reachable from the wire while the board keeps the projection, the two sinks and the redraw. Its **delete is deliberately not on the wire**: where a deleted stage's cards go is a creator's decision, and a wire carrying a remap target would be a second way to decide it. The event family followed at this commit with four of its five verbs: `runEventWrite` now takes the revision the caller read through a resolver, the board answering with the event it was rendering and the wire answering with a revision and **no record**, which is what keeps `event.update` off the wire - it plans a diff against the record it edits. The project lifecycle followed at this commit, and it is the family whose one fact was always just a revision: `runLifecycle` takes it from a resolver the caller owns, so **all five of its verbs** are on the wire - including `project.delete`, which refuses `policy-not-decided` on purpose because what deleting a project does with its members is the creator's decision (D56). The bulk family is the seventh and the one exception to the shape: a bulk run reports a status **per member** rather than one verdict, so `BulkTaskActionReport` is deliberately **not** a member of `AgentWriteResult` and runs through `submitAgentBulk` instead - a union member with no `ok` field would stop `if (!result.ok)` narrowing for every other family, which a compiler is the right oracle for and which this slice found by trying the other way first. `runBulk` also lost its last projection read the same way the others did: each member's revision arrives through a resolver, and the agent sends the revision it read for each member. A partial run reports `ok: true` and `status: 'partial'`, because something did land and calling that a failure is the lie the status field exists to avoid. Behind this slice: the Gantt write made read-model-free at `5781e96`, the schema family on the wire at `2f90e2c`, scoped ordering across surfaces at `b980c33`, the schema action layer at `65f88ef`, the agent write path at `32132bb`, and the contract matrix at `f9c202a` (313 satisfied / 46 gaps / one n/a of 360 cells, counted at the current tree). |
| Branch | `stage7-record-store-contract` |
| Last audited SHA | `5781e96` - fixture generation 0, source/test typecheck 0, build 0, `git diff --check` 0, vitest 0 under default parallelism: 241 test files / 1590 tests, run 2026-09-12 in this working tree. The file count is checked against the tree rather than quoted: 241 `*.test.ts` files exist and the runner collects all 241, which is a check worth keeping because another repository in this workspace turned out to have three test files no script ran. Five mutations of the bulk family's contract were tried and four failed their suite; the fifth - substituting a placeholder revision for a member whose revision the caller did not send - is **equivalent**, because the wire refuses a member without one before the resolver is ever asked, which is where the assertion that covers it lives. Five mutations of the project family's contract were tried and all five failed their suite. Six mutations of the event family's contract were tried and five failed their suite; the sixth - deleting the redraw from the no-write-path branch - survived because no case asserted that order, so one was added and the mutation is caught by it. Five mutations of the stage family's contract were tried and all five failed their suite. Two of the probes earned their keep by finding holes in the tests rather than in the code: a wire that dropped the revision it read survived until a read-back of the stored stage was added, and a delete quietly added to the wire survived the audit's two-way agent-reach assertion - which turned out to be a tautology, because `includes(undefined)` and "named no verb" are the same fact. That assertion is now a documented presence-only guard, and the delete's absence is asserted behaviourally where a delete submitted through the wire must come back refused. The previous slice's sixth probe - preferring the end the caller read over the end it proposed - remains recorded as **equivalent for a valid instant**, proved by reading the span it computes rather than assumed. Writing the probes found a real blind spot in the tests rather than in the code: every early case passed the record's *current* end as its proposal, which made "kept the end it read" and "wrote the end it was given" indistinguishable, so the assertion that separates them was added and the probe now bites. |
| Parity agenda | `D:\Letters\MatTroiSeConMoc\LongHorizon\proxima\proxima-full-parity-checklist.md` (branch `codex/reviewer-send-verification`) carries the full-parity agenda this work is driven by: **816 ticked / 24 open** counting every box the document carries, or **725 / 23** counting only top-level boxes. Both figures are unchanged by this slice, which closed no box - it removed the reason three boxes could not close rather than closing them. Both conventions are stated because the figures on this row have moved before for no reason other than the counting. |
| Papers changed | No Papers change is recorded by this Proxima commit. |
| Papers baseline (exact) | `0a0d89f267f6ca1125159a8b0022c9a620f62e82` - retained as the repository's recorded machine-local baseline, not a fresh current-Papers acceptance claim. |
| Real-vault write authority | **Disabled.** Gate 13 contains the conditional mutation and recovery substrate for memory and disposable roots. Gate 13.3 closes native FSA writing as `BLOCKED / fsa-no-compare-and-swap`; Gate 14 closes owner authority as exact-root-scoped read-only with writes disabled. |
| Canonical cutover | **Never automatic (D67).** The shipped default is the legacy Markdown reader; the record store becomes canonical only through an explicit, one-time, user-invoked activation, and once activated the legacy directories are legacy source only - present, never read as canonical while the store is the source, never deleted. HARD GATE C is closed on that trigger; what is not decided is whether the ordinary UI should *offer* activation. |

## Baseline, unless deliberately changed later

- Papers exact baseline: `0a0d89f267f6ca1125159a8b0022c9a620f62e82`
- Proxima repo: `Futahua/proxima-backpack`
- Obsidian remains a peer application.
- The vault remains canonical creator data.
- Creator-data authority is currently read-only; that is a bootstrap safety milestone,
  not the terminal product scope.
  not the terminal product scope. The creator confirmed this ordering on 2026-09-12
  (D63): Proxima is intended to become a writer eventually, and the present pass is to
  get the read-side UX right first, so artifact and vault-file writes stay unoffered
  rather than half-offered.
- The repository contains conditional mutation, semantic record-writing and recovery
  machinery for memory and disposable roots; no native FSA writer is exposed.
- Native FSA write authority is CLOSED / NO-GO under D51, because the browser API
  cannot atomically validate the observed revision at commit.
- Owner authority is exact-root-scoped read-only under D52; write authority is disabled.
- Final owner mode is intended to support programmatic create, edit, rename/move and
  delete anywhere inside an explicitly creator-granted vault, and is enabled only after
  the remaining bounded-authority, native and coexistence gates below pass.
- KeToan is permanently out of scope.
- Primary product surfaces: Elastic board, calendar, projects, then arbitrary-file /
  canvas work.
- Proxima must remain independently programmable and testable without depending on
  Papers or Obsidian internals.

## Open questions the source does not settle

These are recorded as questions, not answered in prose elsewhere. Nothing below may be
written into `README.md`, `AGENTS.md` or `docs/VAULT-FORMATS.md` as settled behaviour
until it is decided.

- [x] **Unsupported frontmatter on load versus on refresh — CLOSED by evidence at `06619c2`.**
      The question was whether a refreshed generation carrying `unsupported-frontmatter` is
      demoted while the identical vault is accepted at startup. Reading the code, the
      asymmetry is not there: `isBlocking` is severity-only (`src/domain/problems.ts:65-66`)
      and the refresh failure predicate adds exactly one code of its own,
      `frontmatter-parse-failure` (`src/app/refreshController.ts:101-107`).
      `tests/unsupportedFrontmatterRefresh.test.ts` is that reading as evidence: a vault with a
      recognized unsupported construct loads with the warning; a refresh of it is accepted
      (`ok`, outcome `changed`, not stale, no last-refresh problem code); a changed record that
      keeps the construct is accepted with the record moved and the warning still reported; and
      a document whose frontmatter cannot be parsed at all is still refused, so the test is not
      vacuous. No code change was needed, and the creator's answer (D65: preserve and report)
      agrees with what the code already does on this path. **`docs/VAULT-FORMATS.md` needed no edit
      either: it already carries the contract** — "warning-bearing but generation-acceptable ... the
      same bytes are accepted both on initial load and on a later refresh" at its § Not supported, and
      the severity table marks `frontmatter-parse-failure` as the one that refuses a refreshed
      generation. So the documentation was right and the test is what now proves the code matches it.
      *The import side is a different matter and stays open:* the staging planners still treat
      such records as explicit blockers, which is a real change carrying its own module and
      test list on the parity checklist's Stage 8 box.
      visible in it:** `isBlocking` is severity-only (`src/domain/problems.ts:65-66` - `severity ===
      'error'`), and the refresh failure predicate is `isBlocking(problem) ||
- [ ] **Exact currently validated Papers host SHA.** No fresh running-Papers acceptance
      artifact exists for the current tree, and source cannot make a newer Papers
      baseline true.
      *Question:* which exact Papers SHA, if any, has been run against the `071f8c3`
      Proxima build with host-integrated acceptance evidence?
      *Lands in:* the Current status table and a new evidence entry here. Historical gate
      evidence is not edited to accommodate it.
- [ ] **Fresh native creator-vault acceptance for `071f8c3`.** Bridge and disposable
      coexistence runs are not substitutes.
      *Question:* has the exact `071f8c3` build been accepted in the real Papers-hosted
      native FSA path against the intended creator-vault grant, and what artifact
      records that run?
      *Lands in:* Gate 22R below, once such evidence exists.

---

## Gate 1 — Domain and canonical-vault read boundary

### 1.1 Architecture boundary

- [x] `src/domain` has no imports from:
  - [x] Obsidian
  - [x] Papers
  - [x] Electron
  - [x] Node filesystem APIs
  - [x] Svelte/UI framework
  - [x] browser File System Access APIs
- [x] Domain functions are runnable headlessly.
- [ ] UI cannot directly depend on filesystem adapters. _(no UI yet — re-assert at Gate 2)_
- [x] Filesystem adapters cannot contain Elastic/calendar/project business rules.
- [x] Obsidian compatibility logic lives outside the domain.
- [x] Papers-specific behavior lives outside the domain.
- [x] No fake `App`, `Vault`, `TFile`, `WorkspaceLeaf`, or other Obsidian compatibility
      layer exists.

### 1.2 Clock and identity

- [x] Clock is injected anywhere behavior depends on current time.
- [x] ID generation is injected anywhere new identity is created.
- [x] Deterministic fixture clock exists.
- [x] Deterministic sequential/seeded ID generator exists.
- [x] No component or domain operation calls `Date.now()` for business behavior.
- [x] No component or domain operation creates random IDs directly.
- [x] Decide whether production `systemClock` / random ID implementation belongs outside
      `src/domain`; document the choice. → `docs/DECISIONS.md#d1`

### 1.3 Stable record identity

- [x] Distinguish logical record ID from source file path.
- [x] Every loaded record can be traced back to its source file.
- [x] Source provenance includes at least:
  - [x] source path/reference
  - [x] revision
  - [x] record kind
- [x] Renaming a source file does not accidentally redefine an explicit logical ID.
- [x] Legacy records without explicit IDs receive compatibility-correct fallback
      identities.
- [x] Duplicate logical IDs are reported as problems.
- [x] Duplicate IDs are never silently accepted into state.
- [x] Agent-visible IDs and future semantic visual keys use logical IDs, not array
      positions. _(IDs done; visual keys re-asserted at Gate 2.5)_

### 1.4 Existing creator-vault compatibility fixture

At least one fixture representing actual old Proxima storage conventions, not only the
new preferred layout.

- [x] Explicit configurable projects directory.
- [x] Explicit configurable tasks directory.
- [x] Explicit configurable events directory.
- [x] Legacy default paths represented:
  - [x] `-Hide/Proxima/projects`
  - [x] `-Hide/Proxima/tasks`
  - [x] `-Hide/Proxima/events`
- [x] Legacy task IDs derived from filenames are covered.
- [x] Legacy event IDs derived from filenames are covered.
- [x] Flat project format covered: `projects/{id}.md`
- [x] Subfolder project format covered: `projects/{id}/index.md`
- [x] Extra Markdown inside a project subfolder does not become an extra project.
- [x] Legacy `type: project` semantics are either supported or explicitly replaced with
      a documented discovery rule. → `docs/VAULT-FORMATS.md`
  - [x] The veto is scoped to projects, the one kind the plugin discriminated on;
        a legacy task or event carrying an unrelated `type:` still loads.
- [x] Legacy linked-folder representation is tested:
  - [x] `linkedFolder`
  - [x] `linkedFolders: Name|path;Other|path`
- [x] Existing tasks still resolve to the correct projects.
- [x] Existing schedule projects still resolve to calendar rather than board.

### 1.5 Preferred new-vault format

- [x] Decide whether the new canonical Proxima-native layout remains:
  - [x] `<root>/projects`
  - [x] `<root>/tasks`
  - [x] `<root>/events`
- [x] New preferred format is documented separately from compatibility format.
- [x] Reader does not require migration or writes merely to read legacy data.
- [x] Compatibility reader maps both old and new formats into the same clean domain
      model.
- [ ] UI does not care which storage layout produced a record. _(no UI yet — Gate 2)_

### 1.6 Frontmatter safety

- [x] Supported YAML/frontmatter subset is documented. → `docs/VAULT-FORMATS.md`
- [x] Unsupported syntax does not silently become plausible-but-wrong domain data.
- [x] Unsupported syntax produces structured problems where interpretation matters.
- [x] Raw original frontmatter is preserved independently from interpreted values.
- [x] Test:
  - [x] plain scalars
  - [x] numbers
  - [x] booleans
  - [x] null
  - [x] quoted strings
  - [x] inline lists
  - [x] block scalar lists
  - [x] dates/timestamps remain strings where intended
- [x] Test unsupported or dangerous forms:
  - [x] nested maps
  - [x] block mappings
  - [x] list-of-maps
  - [x] multiline `|` scalar
  - [x] multiline `>` scalar
  - [x] commas inside quoted inline-list values
  - [x] trailing YAML comments
  - [x] escaped quoted strings
  - [x] YAML aliases/anchors
  - [x] flow maps
  - [x] alternate boolean spellings
  - [x] UTF-8 BOM before frontmatter fence
- [x] Decide whether to retain a custom parser or adopt a real YAML parser.
      → `docs/DECISIONS.md#d7`: retain, with a mandatory re-decision before Gate 13.
- [x] No future writer serializes from a lossy parsed projection. `ParsedDocument.lossy`
      marks such documents and the `VaultWriter` port carries the obligation.

### 1.7 Numeric/domain validation

Define valid ranges instead of letting malformed frontmatter poison calculations.
Ranges and reasoning: `docs/VAULT-FORMATS.md`; policy: `docs/DECISIONS.md#d8`.

- [x] Task `weight` validation.
- [x] `weight <= 0` behavior specified. Rejected, defaulted to 1, reported.
- [x] `fixedDuration` validation.
- [x] `maxDuration` validation.
- [x] Negative duration behavior specified. Rejected and unset, reported.
- [x] `orderIndex` validation.
- [x] Invalid task status behavior specified. Unusable → `running`, reported;
      unknown-but-well-formed is legal and files under running.
- [x] Invalid dates produce explicit structured problems.
- [x] Invalid records cannot generate NaN/negative Elastic geometry silently.

### 1.8 Elastic behavior parity — **Gate 1C**

Pin important behavior from old `calculateLiquidTimeline`.

- [x] weighted allocation
- [x] fixed durations reserved first
- [x] caps applied independently
- [x] capped remainder is not redistributed
- [x] output preserves task order
- [x] expired/equal deadline returns no timeline
- [x] fixed total may exceed available window
- [x] elastic tasks become zero when fixed work exhausts window
- [x] empty task list
- [x] all-fixed tasks
- [x] fixed task interleaved with elastic tasks
- [x] `isFixedDuration=true` with null/zero duration
- [x] multiple capped tasks
- [x] invalid dates fail closed
- [x] duplicate-ID input cannot alias silently
- [x] malformed numeric inputs are rejected before the algorithm
- [x] Behavior differences from the old plugin are explicitly documented rather than
      described as "unchanged."

### 1.9 Calendar semantics — **Gate 1C**

- [x] Multi-day event day coverage is specified.
- [x] Event whose deadline precedes start has specified behavior.
- [x] Invalid start dates are surfaced.
- [x] Undated/partially dated records have specified behavior.
- [x] Decide timezone semantics:
  - [x] machine-local timezone is intentional; or
  - [ ] timezone becomes explicit/injected.
- [x] Tests are deterministic across CI/developer timezone differences.
- [x] Month boundaries covered.
- [x] Year boundaries covered.
- [x] DST transition behavior covered if local-time semantics remain.
- [x] Pathological finite event spans are bounded and reported rather than silently truncated.

### 1.10 Gate 1 exit criteria

- [x] Both new-format and real legacy-format fixtures load correctly.
- [x] Logical IDs are separate from source paths.
- [x] Duplicate IDs fail visibly.
- [x] No unrelated Markdown becomes a project/task/event accidentally.
- [x] Frontmatter limitations are fail-visible.
- [ ] Elastic behavior is sufficiently pinned. _(Gate 1C)_
- [x] All tests and typecheck pass.
- [x] No Papers changes.

---

## Gate 2 — First visible deterministic fixture surface

### 2.1 Backpack identity

Gate 2A was accepted locally through the normal Papers Backpack UI and the current
Papers project runtime. The identity and absolute-root binding are intentionally
machine-local; the committed `project.json` is only valid on that machine.

- [x] Create actual Backpack in Papers.
- [x] Obtain real `bp-...` identity.
- [x] Add machine-local `backpack-projects.json` binding.
- [x] Commit `project.json` only if its `backpackId` matches the real binding.
- [x] `entry` points inside `public/`.
- [x] No placeholder Backpack ID is ever committed.

### 2.2 Build system

- [x] Produce a real browser-runnable static build.
- [x] Build output lives under `public/`.
- [x] Build does not depend on Obsidian runtime.
- [x] Build does not depend on Node in the page.
- [x] Build does not require network access.
- [x] Asset URLs remain inside the Papers namespaced project path.
- [x] Clean checkout + install + build is reproducible.
- [x] Build identity is generated and inspectable:
  - [x] Proxima version
  - [x] exact git SHA
  - [x] build mode
  - [x] domain schema version
  - [x] control schema version
  - [x] fixture schema/hash
  - [x] lockfile/dependency fingerprint as appropriate

### 2.3 Fixture-only boot

- [x] Page boots using bundled fixture bytes.
- [x] No FSA picker required.
- [x] No real creator vault accessed.
- [x] Fixture mode is visibly/machine-readably distinguishable from live mode.
- [x] Fixed clock can be selected in fixture mode.
- [x] Deterministic IDs used in fixture mode.

### 2.4 First UI surface

Minimum useful shell only.

- [x] Projects navigation.
- [x] Elastic board.
- [x] Calendar.
- [x] Switching surfaces preserves valid selection.
- [x] Schedule project cannot leak into board selection.
- [x] Task project cannot become a calendar-only selection.
- [x] No write controls imply that real creator data can be modified.

### 2.5 C1 visual semantic keys

- [x] Top-level app/root key.
- [x] Project navigation region key.
- [x] Board region key.
- [x] Calendar region key.
- [x] Backlog/running/finished column keys.
- [x] Project item keys based on stable domain IDs.
- [x] Task card keys based on stable task IDs.
- [x] Event keys based on stable event IDs.
- [x] Empty/error/loading states have semantic keys where relevant.
- [x] No semantic key depends on:
  - [x] CSS selector
  - [x] component implementation name
  - [x] visible translated text
  - [x] list index
- [x] Total keys remain within Papers' bounded C1 contract.

### 2.6 Papers lifecycle diagnostics

- [x] Report state hydrated only after fixture state is actually ready.
- [x] Hydration revision is deterministic.
- [x] Bounded numeric hydration summary includes useful counts.
- [ ] Parse/load failure reports a structured hydration failure.
- [ ] Unhandled errors remain visible through Papers diagnostics.
- [ ] Layout stability reaches C1.

### 2.7 Gate 2 evidence

- [ ] `visual.wait` reaches layout-stable.
- [ ] `inspect.visual.diagnostics` clean.
- [ ] `inspect.visual.timeline` sane.
- [ ] `inspect.visual.elements` sees expected semantic keys.
- [ ] `visual.assert` covers important visibility/clipping relationships.
- [ ] `capture.surface` recorded.
- [ ] Important `capture.element` samples recorded.
- [ ] Exact Proxima and Papers build identities recorded.
- [ ] Gate 2 does not require a Papers host change.

---

## Gate 3 — Proxima programmability foundation

Exists before UI behavior becomes large.

### 3.1 Semantic action surface

- [x] Define versioned project-owned action catalog (`ACTION_SCHEMA_VERSION = 1`).
- [x] Actions express user/domain intent rather than UI mechanics.
- [x] Human UI uses the same action dispatcher.
- [x] Tests use the same action dispatcher.
- [x] No test-only direct Svelte/store mutation path.
- [x] Actions have stable machine-readable names.
- [x] Action inputs are schema-validated.
- [x] Action outputs are schema-validated.
- [x] Errors have stable codes, not only prose.

Potential categories:

- [x] navigation/select project
- [x] board selection/filtering
- [x] calendar navigation
- [x] fixture reset/load
- [ ] refresh/reload source
- [ ] future canvas selection/open
- [x] mutation actions remain fixture-only while real vault is read-only
- [x] first agent-facing record write entry — `src/app/agentWritePath.ts` submits the two drop
      verbs (`task.execution.move` / `task.execution.reorder`) to `moveTaskByGesture` over a
      resolved store, with the revision the agent read made a required field, one request id
      minted before the submission is parsed, and one terminal semantic event; every other
      registered record or artifact verb is answered `unsupported-verb` with the sentence
      saying where it belongs, derived from `registeredActionTypes()` rather than a hand-kept
      list. It is a sibling entry, not a `ProximaAction`, so the dispatcher's containment rule
      is unchanged and is asserted in the same suite. `performElasticDrop` correspondingly
      stopped reshaping the gesture's result, which is what lets the two entries be compared
      as whole objects rather than as a chosen subset of fields
      (`tests/agentWritePath.test.ts`, `docs/DECISIONS.md#d73`).
- [x] the property-schema verbs have a boundary — `src/app/propertySchemaActions.ts` is the entry the
      three schema rows of the contract matrix were missing: it accepts `unknown` and answers a
      submission it cannot read with a sentence, answers a verb it does not run with
      `action-not-available`, mints one semantic request id **before** it parses anything, submits to
      the record layer's own operations (so the domain constructor stays the only validator of a
      property definition), returns the record's revision and the ids the run touched, and appends one
      terminal event named for the verb (`property.schema.create` / `.update` / `.delete` /
      `.option.change` / `.field.change`). It is a sibling entry rather than a `ProximaAction`, for
      D72's reason: the registry carries no schema verb, and putting a record write behind `dispatch`
      is what the containment rule exists to prevent. The record layer keeps its own gaps and the
      matrix still asserts them — it takes typed requests only, drops the coordinator's id and emits
      no event — while the three rows now carry the boundary, the id and the event through overrides
      (`tests/propertySchemaActions.test.ts`, `docs/DECISIONS.md#d74`).

### 3.2 State-inspection seam

- [x] Define a versioned read-only inspection projection (`INSPECTION_SCHEMA_VERSION = 1`).
- [x] It is independent of Svelte/store implementation.
- [x] Includes:
  - [x] build identity
  - [x] mode: fixture/live
  - [x] application state revision
  - [x] current surface
  - [x] current selection
  - [x] project summaries
  - [x] board/task summaries
  - [x] calendar/event summaries
  - [x] load problems
  - [x] source revisions as safe logical metadata
  - [x] pending operations
  - [x] degraded/error state
  - [x] latest event sequence (reserved at `0` until Gate 3B event ring)
- [x] Real-vault inspection redacts unnecessary machine information.
- [x] Fixture inspection may include fixture-relative paths where useful.

### 3.3 Application revision and settling

- [x] Define application-state revision.
- [x] Revision changes deterministically when meaningful state changes.
- [x] Define "idle" / "settled" semantics.
- [x] Agent can tell when:
  - [x] source read completed
  - [x] derived state completed
  - [x] render updated
- [x] No tests rely on arbitrary sleeps.

### 3.4 Structured event ring

- [x] Versioned event envelope.
- [x] Monotonic sequence number.
- [x] Event kind.
- [x] Logical entity IDs.
- [x] Operation/request ID where relevant.
- [x] State revision after event where relevant.
- [x] Injected timestamp.
- [x] Bounded in-memory retention.
- [x] `events.read(afterSequence)` or equivalent query.
- [x] Events distinguish domain facts from diagnostic logs.

### 3.5 Structured diagnostics

- [ ] Machine-readable diagnostic codes.
- [ ] Bound payload sizes.
- [ ] Parse failures.
- [ ] Unsupported frontmatter.
- [ ] Duplicate IDs.
- [ ] Missing relationships.
- [ ] Invalid dates/numbers.
- [ ] Renderer failures.
- [ ] Filesystem/repository failures.
- [ ] No credentials/tokens dumped.
- [ ] Real machine paths are redacted where not necessary.

### 3.6 Evidence format

- [x] Machine-readable scenario result schema.
- [x] Includes:
  - [x] scenario ID
  - [x] Proxima build
  - [x] Papers build/process identity (optional field, populated only by host acceptance)
  - [x] fixture hash
  - [x] deterministic clock seed/value
  - [x] ID seed/sequence configuration
  - [x] action transcript
  - [x] event transcript
  - [x] initial state revision
  - [x] final state revision
  - [x] domain assertions
  - [x] C1 visual assertions
  - [x] diagnostic/timeline excerpts
  - [x] capture artifact hashes/IDs
  - [x] pass/fail result
- [x] Evidence can be reproduced from a clean fixture run.

### 3.7 Gate 3 exit

- [ ] Proxima can be driven headlessly without Papers.
- [ ] Same semantic actions power UI and tests.
- [ ] State can be inspected without touching renderer implementation details.
- [ ] Deterministic events/evidence exist.
- [ ] Live Papers control is still optional at this point.

---

## Gate 4 — Filesystem adapter conformance

### 4.1 Repository conformance suite

One common behavioral suite runs against every storage implementation.

- [x] list directory
- [x] recursive walk
- [x] read text
- [x] exists
- [x] revision changes after modification
- [x] path normalization
- [x] Unicode filenames
- [x] spaces/punctuation
- [x] nested directories
- [x] missing file
- [x] missing directory
- [x] unreadable file behavior (permission-denied injection pins fail-visible rejection;
      native ACL manufacture remains platform-dependent and is documented)
- [x] deterministic ordering
- [x] large-but-reasonable file
- [x] no traversal outside granted root

The shared assertions live in `tests/adapterConformance.test.ts`. They run against
the memory adapter, a disposable real disk fixture, and an OPFS-shaped handle.

### 4.2 Memory adapter

- [x] Clearly documented as an in-process adapter.
- [x] Does not claim to test Windows/FSA semantics.
- [x] Revision semantics are deterministic.
- [x] Delete/recreate changes revision appropriately.
- [x] Path normalization is covered.

### 4.3 Real disk fixture adapter for headless tests

- [x] Run against actual fixture directories on disk.
- [x] Real rename behavior.
- [x] Real delete/recreate.
- [x] Real mtime/content changes.
- [x] External writer process can mutate fixture during test.
- [x] Never point automated mutation tests at creator's real vault.

### 4.4 Browser OPFS adapter

- [x] Same repository contract.
- [x] Same conformance suite where semantics overlap.
- [ ] Browser-native `FileSystemDirectoryHandle` use tested without user picker.
- [x] Explicitly document what the OPFS-shaped adapter cannot prove:
  - [x] external Obsidian edits
  - [x] Windows absolute paths
  - [x] cross-process contention
  - [x] user-granted external directory persistence

The current OPFS test uses the structural subset of a directory/file handle and does
not claim native browser permission or persistence behaviour. Those claims belong to
the real FSA spike in Gate 5.

### 4.5 Gate 4 exit

- [x] Core repository contract is proven across at least memory + real fixture disk +
      OPFS.
- [x] No Papers host change required.

---

## Gate 5 — Real File System Access spike in Papers

Disposable data only.

### 5.1 Capability proof

Inside the real `papers-backpack://` surface:

- [x] `showDirectoryPicker({mode:'readwrite' or read as appropriate})` availability
      proven: the real Papers page reports a function in a secure context.
- [x] User gesture requirement recorded: a deferred non-gesture call is rejected by
      the real surface; selection still needs a foreground gesture acceptance run.
- [x] Selected disposable directory can be enumerated.
- [x] Files can be read with bounded relative-path/text evidence.
- [x] Current on-disk state is observed after an external edit without reacquisition.
- [x] Handle can be stored in IndexedDB and restored after an in-place Papers reload.
- [x] Full Papers process restart behavior tested with the same Papers profile and
      disposable fixture.
- [x] `queryPermission()` state recorded after the in-place reload (`prompt`) and
      after the full process restart (`granted`).
- [x] Foreground `requestPermission()` behavior recorded (`prompt` → `granted`).
- [x] Acceptance report is validated as bounded, relative-only evidence, with a
      fixed-path disposable-fixture reset helper (`src/app/fsaEvidence.ts`, D19).
- [x] Clean-profile acceptance harness evaluates the captured report against the
      exact disposable fixture shape and emits structured failure codes (D21).
- [x] Browser surface emits the harness result alongside each captured FSA report;
      no manual evidence transcription is required (D22).
- [ ] Clean-profile behavior recorded. _(pending the final native picker; no PASS inferred)_

Clean-profile acceptance preparation is complete but intentionally unexecuted: an
isolated Papers data directory contains only copied Backpack registry/binding
metadata (no IndexedDB/FSA state), and a fresh disposable fixture contains the same
bounded three-file shape with a distinct initial marker. The native picker grant and
all subsequent clean-profile observations remain unchecked until a foreground user
gesture is performed.

The same real Papers surface also completed a disposable OPFS write/read/delete
round-trip and an IndexedDB write/read/delete round-trip. Those prove storage APIs
exist in the origin, not external-directory selection or durable directory-handle
permission. Gate 5 evidence used `gate5-fsa-fixture`: the first foreground
selection read `root-note.txt` and `nested/child-note.txt`; a separate Node process
appended `external-fsa-edit-v1`; a cached-handle reread observed the changed bytes and
revision; an in-place Papers reload restored the handle in `prompt`; and a second
foreground read request restored `granted`. No absolute path was emitted and no
creator-vault data was touched. A normal full Papers exit/relaunch then restored the
same persisted handle without a new picker; read permission was `granted`, and the
restored read included the external marker. Clean-profile checks remain open.

### 5.2 Read-only real vault

- [ ] Grant actual creator vault manually. _(after clean-profile acceptance)_
- [ ] Proxima reads through the same repository contract. _(after clean-profile acceptance)_
- [ ] No writes.
- [ ] No migration.
- [ ] No automatic reorganization.
- [ ] Legacy source fixture and creator data agree on semantics.
- [ ] External Obsidian edit becomes visible after refresh/reload.
- [ ] Rename/delete behavior is observable and safe.

### 5.3 FSA decision

- [x] FSA is sufficient for the disposable v1 read-only viability slice; or
- [ ] Specific failed acceptance test proves it is insufficient.

If insufficient, state the missing truth exactly before asking Papers for anything.
Possible specific truth:

- [ ] Backpack cannot durably enumerate/read a creator-selected external directory
      using available browser capabilities.

Only then consider a project-scoped external read capability in Papers.

---

## Gate 6 — Read-only real-vault product surface

### Defined-scope contract (Gate 6.5B)

**PASS for the audited read-only product surface** over fixture, disposable
external-directory, loopback-bridge and explicitly evidenced real-vault/Obsidian
substages. This contract does not claim native Papers-hosted access, durable native
FSA/picker lifecycle, native watcher behavior, or broad native-host acceptance; those
rows remain OPEN until directly evidenced.

### 6.1 Source refresh model

- [x] Read-only pull refresh controller exists over `VaultReader` (Gate 6A, D24).
- [x] Manual/focus/interval/external-signal reasons are a closed enum.
- [x] Source revisions, stale/degraded state, last-good preservation, bounded
      diagnostics, and serialized refresh state are explicit and tested.
- [x] Manual refresh exists in the real-vault UI — the rendered `Refresh source`
      control dispatches the normal `SourceSession.refresh('manual')` path; native
      host acceptance remains covered separately by the OPEN rows below.
- [x] Refresh-on-focus considered/tested — the browser focus handler uses the same
      `SourceSession.refresh('focus')` path, with trigger-policy coalescing covered by
      `tests/refreshPolicy.test.ts` and end-to-end failure/recovery coverage.
- [x] Bounded polling considered/tested if needed — the policy uses one bounded,
      visibility-aware timer with a nonzero minimum and idempotent disposal.
- [x] External edit produces new source revision — refresh-controller and external
      directory tests pin generation/revision advancement.
- [x] Deleted source disappears or becomes explicit missing state — refresh
      classification and selected-project cleanup are covered by the integration suite.
- [x] Renamed source follows defined identity semantics — disposable external-directory
      acceptance in `tests/obsidianCoexistence.test.ts` (Gate 6R, `fff4fee`); this does
      not claim actual Obsidian/Papers-hosted rename acceptance.
- [x] UI never shows stale state as confirmed-current without indication — failed
      refreshes retain last-good content while the health surface labels stale or
      degraded state; `tests/uiHealth.test.ts` and refresh integration cover this.

### 6.1A Provenance-aware product projection (Gate 6B)

- [x] Projects/Board/Calendar consume one bounded accepted refresh generation.
- [x] Every exposed project/task/event carries logical id, source kind, relative
      source path, source revision, and id-origin provenance.
- [x] Projection carries source/app revision, stale/degraded health, last successful
      refresh revision, last refresh reason, and bounded problem codes.
- [x] Successful edits update cross-surface consumers atomically from one snapshot.
- [x] Malformed/unreadable refreshes preserve the last-good domain generation while
      exposing stale/degraded health; recovery advances it atomically.
- [x] Inspection output is bounded and copy-safe; no reader/controller/file handle
      or mutable internal object escapes.
- [x] Board elastic semantics and Calendar problem-sink behavior remain covered.
- [x] Fixture/disposable-reader tests cover provenance, coherence, failure retention,
      and mutation isolation (Gate 6B, D25).
- [ ] Real-vault projection acceptance.

### 6.1B Refresh trigger and policy wiring (Gate 6C)

- [x] Policy layer sits above `RefreshController` and never reads the vault itself.
- [x] Manual, focus, interval, and external-signal triggers converge through one
      refresh(reason) path.
- [x] Focus/external trigger storms are coalesced behind an in-flight refresh.
- [x] Interval is bounded by a nonzero minimum and start is idempotent.
- [x] Stop/disposal removes timers and prevents future refreshes.
- [x] Hidden state suspends interval polling; becoming visible only re-arms the timer,
      and the browser window-focus adapter owns the single focus refresh through the
      same path.
- [x] Failed refreshes do not create tight automatic retry loops.
- [x] Inspection state is bounded: enabled, interval, last reason, counters, timer,
      and visibility.
- [x] Core policy tests use injected scheduling and no DOM/window/host authority.
- [ ] Real-vault trigger acceptance or native watcher.

### 6.1C Stale/degraded UI and inspection integration (Gate 6D)

- [x] One bounded UI health model is derived from the accepted read-only projection.
- [x] Stable C1 health surface exposes status, stale/degraded, source/application
      generation, last successful refresh, last reason, and bounded problem codes.
- [x] Projects, Board, Calendar, and inspection share the same health generation.
- [x] Unreadable/malformed refresh retains last-good content and visibly marks stale or
      degraded; no cards, projects, or events disappear just because refresh failed.
- [x] Recovery clears health degradation and advances all surfaces atomically.
- [x] UI/inspection details remain bounded and path-safe, with no controller/reader,
      file handle, DOM object, or mutable internal authority exposed.
- [x] Repeated failure, recovery, and health mutation-isolation tests are present.
- [ ] Real-vault UI health acceptance.

### 6.1D Fixture-mode end-to-end refresh wiring (Gate 6E)

- [x] Browser fixture bootstrap instantiates the complete VaultReader → controller →
      policy → projection → health → dispatcher/inspection/UI chain.
- [x] Stable `source-refresh` C1 control routes through policy manual refresh.
- [x] Policy results apply to the dispatcher atomically for manual, focus, and
      interval paths; DOM lifecycle wiring remains an outer adapter.
- [x] Unchanged refresh does not advance observable source/application generation.
- [x] External edit updates Projects, Board, Calendar, provenance, health, and
      inspection from one accepted generation.
- [x] Deletion removes visible records and safely reconciles cross-surface selection.
- [x] Failed refresh retains last-good UI content while health becomes degraded/stale.
- [x] Recovery clears health and advances all visible surfaces without app reload.
- [x] Dispatcher action revision, settled state, lifecycle events, and pending
      operations remain coherent across refresh.
- [x] End-to-end fixture tests cover boot, unchanged/edit/deletion/failure/recovery,
      focus/manual policy routing, inspection/UI generation equality, and authority
      boundaries (Gate 6E, D28).
- [ ] Real-vault/FSA end-to-end refresh acceptance.

### 6.1E Injected external-directory reader integration (Gate 6F)

- [x] Structural FileSystemDirectoryHandle-like input adapts to `VaultReader`.
- [x] Browser source factory accepts injected reader/handle while fixture remains the
      default.
- [x] Raw handle does not enter domain, dispatcher, inspection, globals, or actions.
- [x] Traversal is rejected; recursive enumeration is deterministic and bounded by
      entry count, depth, and file size.
- [x] Reads are read-only and do not request permission or obtain writable handles.
- [x] External mutation is visible on later refresh through the existing stack.
- [x] Deletion/rename and unreadable entries reuse 6A last-good/fail-visible semantics.
- [x] Relative provenance is preserved without absolute-path leakage.
- [x] Adapter tests cover structural boot, nested ordering, traversal, bounds,
      mutation, deletion, failure, and no permission authority (Gate 6F, D29).
- [ ] Native picker/creator-vault external-source acceptance.

### 6.1F Persisted-handle bootstrap contract (Gate 6G)

- [x] Restored handle enters through injected store + read-permission provider seams.
- [x] Bootstrap calls `queryPermission({mode: 'read'})` only; no automatic
      `requestPermission`, picker, or IndexedDB write.
- [x] `granted` constructs the existing external-directory `VaultReader` path.
- [x] `prompt`, `denied`, no-handle, restore/query failure, and invalid structure are
      explicit bounded statuses with fixture fallback where access is unavailable.
- [x] Raw handle is discarded at the boundary; only safe bounded kind/name metadata is
      available to inspection, and no absolute path is exposed.
- [x] Restored granted readers reuse the 6F–6E refresh/projection/health/dispatcher/UI
      path without a parallel implementation.
- [x] In-memory persistence and permission fakes cover all bootstrap states and prove
      no write-capable or permission-request authority (Gate 6G, D30).
- [ ] Native restored-handle/creator-vault acceptance.

### 6.1G Source-mode transition state machine (Gate 6H)

- [x] Explicit fixture/external source session with stable/switching/failed states.
- [x] Source transitions are serialized and generation-tagged.
- [x] Late old-source refresh completions cannot overwrite the active source.
- [x] Active policy timers/triggers are disposed and rebound without duplication.
- [x] External activation accepts only an already-authorized `VaultReader` + snapshot;
      no picker, permission request, IndexedDB, filesystem, or host API is called.
- [x] Failed external activation preserves one coherent previous source and reports a
      bounded failure; fixture fallback/return drops external authority references.
- [x] Board/Projects/Calendar/inspection/health receive one complete accepted
      generation; selection reconciliation and dispatcher settled/event semantics stay
      coherent.
- [x] Transition tests cover fixture→external, external→fixture, failure, rapid/late
      completion, policy disposal/rebind, generation agreement, and no authority leak
      (Gate 6H, D31).
- [ ] Native source-mode transition acceptance.

### 6.1H Restart/session restoration semantics (Gate 6I)

- [x] Startup/session orchestrator consumes 6G bootstrap and creates exactly one 6H
      source session.
- [x] No handle, granted, prompt, denied, query failure, and activation failure have
      deterministic fixture/external startup states with bounded metadata.
- [x] Repeated initialization on one orchestrator is idempotent; policies/timers do
      not duplicate.
- [x] Simulated restart restores the same external logical state without re-selection.
- [x] Permission loss after restored boot preserves last-good data and degrades through
      the normal refresh path; a later granted restart recovers healthy state.
- [x] Disposed prior sessions cannot commit late work or leak authority into the new
      session.
- [x] Startup inspection is bounded and exposes no raw handles, stores, providers,
      readers, policies, timers, picker, host, write, or migration authority.
- [x] Tests cover cold fixture, granted external, prompt/denied/query fallback,
      activation failure, restart equivalence, permission loss/recovery, disposal,
      duplicate prevention, and authority isolation (Gate 6I, D32).
- [ ] Native restart/creator-vault restoration acceptance.

### 6.1I Real-vault readiness/evidence contract (Gate 6J)

- [x] Bounded `RealVaultAcceptanceReport` schema is derived only from startup,
      session, projection, health, inspection, and explicit refresh evidence.
- [x] Pure evaluator requires an external/granted/stable/healthy coherent baseline,
      source revisions, and provenance samples for every present record kind.
- [x] External-edit and rename/delete stages require changed revisions/content or
      safe path evidence; missing evidence remains `OPEN` rather than inferred.
- [x] Write-invariant stage fails on any writer method or attempted write; report
      paths, text, codes, and build identity are bounded and absolute paths are
      rejected without echo.
- [x] Browser render seam accepts only a validated bounded report and exposes no
      authority objects or source APIs.
- [x] Tests cover healthy baseline, fixture/stale/mixed-generation rejection,
      provenance/path/privacy bounds, unchanged edit claims, staged `OPEN`, and
      write-authority failure (Gate 6J, D33).
- [ ] Native creator-vault readiness, real-directory integration, and Obsidian
      coexistence acceptance.

### 6.1J Live external-source browser acceptance wiring (Gate 6K)

- [x] Browser bootstrap composes the 6I startup/session orchestrator; fixture
      remains the deterministic fallback when no restored source is present.
- [x] Accepted source projections replace UI state atomically and recompute the
      bounded 6J report at startup and after refresh callbacks.
- [x] Refresh evidence is derived from normal refresh outcomes plus before/after
      accepted projections; rename/delete evidence is derived from source deltas.
- [x] Fixture startup is visibly non-PASS; no parallel real-vault controller or
      special source path is introduced.
- [x] No raw handle/reader/session/controller/policy/store/provider/DOM authority
      crosses inspection or global report seams; no absolute paths are emitted.
- [x] Tests cover live revision evidence, rename/delete derivation, and existing
      refresh degradation/recovery and stale-callback protections (Gate 6K, D34).
- [ ] Native creator-vault selection and actual real-directory browser acceptance.

### 6.1K Creator-vault read-only runbook/guard (Gate 6L)

- [x] Hard `readOnly` preflight is represented by pure READY/BLOCKED/ABORTED
      guard state, not a UI convention.
- [x] Guard checks source/permission/session/health/build/root/provenance and zero
      write invariants, with bounded abort codes and no repair/fallback writes.
- [x] Evidence plan names baseline, edit, rename/delete, Obsidian, and write stages;
      optional or missing stages remain OPEN and are not inferred.
- [x] Native boundary is explicit and limited to select-and-grant when needed;
      guard itself has no picker, filesystem, Papers, or writer authority.
- [x] Tests cover safe readiness, wrong source/build, write abort, and authority-free
      bounded output (Gate 6L, D35).
- [ ] Native creator-vault preflight and selection.

### 6.1L Disposable peer-writer/Obsidian-coexistence simulation (Gate 6M)

- [x] A temporary disk fixture and separate child-process writer simulate a peer
      editor without calling Proxima internals.
- [x] Edit/create/rename/delete and rapid peer changes are observed only through
      normal SourceSession refresh and source-delta evidence.
- [x] Malformed intermediate bytes retain last-good UI and mark stale/degraded;
      subsequent valid bytes recover without restart.
- [x] Identity, selection reconciliation, generation coherence, and zero Proxima
      writes remain explicit under peer changes.
- [x] No Obsidian API/plugin runtime, creator vault, picker, Papers bridge, or watcher
      capability is introduced (Gate 6M, D36).
- [ ] Actual Obsidian/creator-vault coexistence acceptance.

### 6.1M Final creator-vault native-grant preflight composition (Gate 6N)

- [x] Pure `evaluateCreatorVaultPreflight` composes bounded 6J, 6L, and 6M
      readiness outputs without source or native authority.
- [x] `READY_FOR_NATIVE_GRANT`, `BLOCKED`, and `ABORTED` are distinct; blocker
      codes identify build, runbook, write, coexistence, path, and host failures.
- [x] Ready requires expected build, valid 6J evidence, READY runbook, zero writes,
      safe bounds, disposable simulation PASS, resolved capabilities, and no path
      leakage; clean-profile FSA and real Obsidian remain OPEN.
- [x] Output is copy-safe, authority-free, deterministic, and explicitly forbids
      writes, migration, autofix, watcher assumptions, and Papers changes.
- [x] Browser renders one stable C1 preflight surface/global; tests cover ready,
      blocked, aborted, unsafe-path, and deterministic outputs (Gate 6N, D37).
- [ ] Native creator-vault select/grant action.

### 6.1N Zero-click read-only agent bridge (Gate 6O)

- [x] A loopback-only bridge exposes bounded list/read/exists/walk operations for an
      explicitly configured root; no native picker gesture is required for automation.
- [x] Agent-enabled browser startup consumes the bridge through the existing structural directory seam
      and preserves the read-only source/session/runbook/preflight pipeline.
- [x] Non-loopback URLs, traversal, oversized responses, and non-GET methods are rejected;
      bridge tests exercise the real child process and temporary disk fixture.
- [x] README documents the explicit agent-build opt-in, root configuration and `?bridge=` bootstrap.
- [x] Bridge failures answer in a closed code vocabulary; no filesystem `error.message`,
      errno text, or absolute root reaches an HTTP body, startup line, or evidence
      bundle. Pinned by `tests/bridgeDisclosure.test.ts`.
- [x] Allowed origin reflects a loopback page's own origin with `Vary: Origin` rather
      than a hardcoded dev port, and a non-loopback `Host` is refused, closing DNS
      rebinding. The rebinding case is exercised over raw `node:http`, because `fetch()`
      drops a `Host` header and would have asserted nothing.
- [x] Documented in the strong form: the bridge **cannot operate inside Papers**
      (`papers-backpack://` origin, `connect-src 'none'`), so bridge-backed acceptance is
      never Papers-hosted acceptance. → `docs/DECISIONS.md#d38`
- [ ] Native creator-vault grant and real Obsidian coexistence acceptance remain OPEN.

**Ledger correction (audited at `d95fb43`, first review with the diff actually
readable).** Gate 6O at `5bf635e` is **FAIL, retroactively**: it forwarded raw
filesystem errors carrying the absolute vault root, and pinned CORS to a guessed dev
port. Gate 6O **PASSES at `d95fb43`**. Verdicts issued while the source was unpushed
were not audits; see the process rule below.

### 6.1O Provable invariants correction (Gate 6M/6N)

- [x] Gate 6M zero-write evidence is non-vacuous: a proxied reader records reads, throws
      on anything outside the read surface, and the tree is fingerprinted so an
      unattributed change fails the run. The witness itself fails when it recorded no
      reads, so an unwired instrument cannot report success.
      → `tests/zero-write-witness.ts`, `tests/zeroWriteWitness.test.ts`
- [x] Gate 6N live browser composition no longer passes a hardcoded coexistence literal.
      Readiness is declared, defaults to every field false, and is coerced from literal
      `true` only. → `src/browser/coexistenceReadiness.ts`
- [ ] Gate 6N live browser READY composition remains **OPEN**: the surface stays BLOCKED
      until an acceptance run declares observed evidence. This is the true state of a
      freshly booted page, not a placeholder.

### Process rule — an unpushed gate is not audited

Gates 2B–6O were implemented and reported without being pushed. The reviewer said
"not resolvable from the connected remote" on four consecutive verdicts and passed them
anyway on the strength of the summary; the first review with the real diff overturned
one gate and qualified two others. Therefore: **push the slice, confirm the SHA resolves
on the remote, and only then request the audit.** A verdict on unreadable code records
confidence, not review.

### 6.1P Unattended bridge-backed acceptance harness (Gate 6P)

`npm run agent:accept -- --root <root>` — one command, an explicitly supplied root,
no picker, no gesture, nobody at the screen.

- [x] Explicit root required; the harness never discovers, guesses or crawls for one.
- [x] Ephemeral bridge port by default; the bridge reports the port it actually bound
      rather than the one requested, which is what made `--port 0` usable at all.
- [x] Drives the audited `d95fb43+` bridge and the same compiled adapter, domain and
      repository modules the browser loads — not a second parser. The build output is
      loaded through `require()` rather than `import()`, because a Vite-based runner
      rewrites dynamic specifiers to its own graph and does not decode a
      percent-encoded file URL, so a directory with a space in its name fails.
- [x] Transport disclosure is a hard prerequisite, probed **before** any vault byte is
      read: bounded codes only, and neither the bridge's startup output nor any failure
      body may contain the root.
- [x] Zero-write consumes `createZeroWriteWitness` — no second counter. Liveness,
      capability and effect are checked in that order, since an unwired witness would
      make the other two meaningless.
- [x] Undeclared on-disk change ⇒ ABORTED. Attribution is path-specific: a rename must
      declare both ends. The decision is an exported pure function so it is tested
      directly rather than through a test-only hook.
- [x] The supplied root never appears in stdout, stderr, the result, or an error, on
      any outcome. Asserted over PASS and ABORTED runs.
- [x] Bounded machine-readable result: `PASS | BLOCKED | ABORTED`, per-stage verdicts,
      bounded blocker codes, observed read count, record counts.
- [x] Result carries `transport: "loopback-agent-bridge"` and `papersHosted: false`;
      native FSA, clean-profile picker, real Obsidian coexistence and write/concurrency
      stay OPEN on the result itself even when the run passes.
- [x] Cleanup terminates only the bridge this run started and waits for its handles to
      close; the CLI sets an exit code rather than calling `process.exit()`, which was
      aborting the process with a libuv assertion after a successful run.
- [x] Regression required by the reviewer: a run with a deliberately unwired witness
      **cannot** PASS — it aborts with `zero-write-witness-unwired` and zero observed
      reads, even against a perfectly clean source.
- [x] The real 6J → 6L → 6N evaluators decide the verdict. The harness loads the
      compiled `realVaultAcceptance`, `realVaultRunbook` and `creatorVaultPreflight`
      and reports what they said; it no longer constructs a verdict of its own.
      They run **after** the zero-write and path-safety instruments report, so their
      input is this run's observations rather than an assumption made before the
      checks.
- [x] 6J is judged on `stages.baselineRead`, not on `passed`: the overall verdict
      folds in external-edit, rename/delete and Obsidian stages that a single
      baseline read cannot observe and that stay OPEN by design. Both are reported.
- [x] The two preflight blockers a loopback bridge cannot clear —
      `coexistence-simulation-missing` and `host-capability-unresolved` — are an
      explicit set, reported as `openBlockers` rather than excused silently. Any
      other blocker fails the run.
- [x] Regression: a source the evaluators reject cannot PASS even when transport and
      witness stages are green, driven by a genuinely malformed vault rather than a
      test-only hook.
- [x] Layout resolved by a narrow read-only probe of exactly the two canonical roots.
      Both present ⇒ `ambiguous` ⇒ ABORTED, never a silent choice: preferring one
      would mean reporting half a vault as the whole of it. No recursive search.
- [x] Module loading fails closed. The dynamic-import fallback is gone, because it
      would reintroduce the runner-graph ambiguity the `require()` path exists to
      remove, and 6P wants certainty about which artifact executed.
- [ ] Run against the actual creator vault. Not yet performed; this gate covers the
      harness being source-tested, not the real baseline it makes possible.

### 6.1Q Severity-aware baseline semantics (Gate 6P.1)

Raised by the legacy fixture and specified by the reviewer: the baseline condition
was severity-blind, failing whenever any problem existed. A creator vault of any
size carries at least one benign warning, so a real baseline was close to
unreachable and would have rejected a healthy vault for something that is not a
defect.

- [x] A known warning is visible and does not fail `baselineRead`.
- [x] An error-severity problem still blocks.
- [x] A problem whose severity cannot be classified **fails closed**, so a severity
      added elsewhere later cannot become silently non-blocking here.
- [x] No numeric allowance and no caller-supplied tolerance: either would let unknown
      problem classes be blessed into a pass.
- [x] Warnings are reported as bounded evidence (`baselineWarnings`), not discarded.
- [x] The rule lives in 6J. Neither 6L nor the harness waives `baseline-problems`,
      so acceptance semantics cannot diverge by caller.
- [x] The acceptance input carried no `severity` field at all, so the classification
      never reached the evaluator. The contract now carries it.
- [x] Fixture matrix: basic PASS, legacy PASS (warning-only), malformed PASS
      (warning-only by design — records still load with defaults), duplicates
      BLOCKED (error-severity `duplicate-id`).

The regression suite is `tests/baselineSeverity.test.ts`: warning-only passes,
one error fails, warning+error fails with warnings still reported, unclassified
severity fails, warning codes stay bounded, and the other stages stay OPEN rather
than quietly passing.

### 6.1R Transport completeness and candidate accounting (Gate 6Q.1)

The first Gate 6Q execution against the creator's real vault was a **false PASS**:
every stage green while all four projects silently failed to load. Two independent
defects, both now closed.

**Symlink traversal.** One project folder held a dangling link — `Corn`, created by
Proxima's own `linkedFolder` feature — and the bridge threw on any symlink while
listing, so one bad entry failed the entire recursive walk and erased all 31 project
folders. Events, containing no links, were unaffected.

- [x] `list` omits symlinks and returns a bounded `skippedSymlinks` count; `walk`
      recurses ordinary directories only and aggregates the count.
- [x] A link never causes sibling entries or its containing directory to disappear.
- [x] Link targets are never returned, and never resolved: internal and external
      targets are not distinguished, because distinguishing them means following.
- [x] A direct `read` of a path that *is* a symlink still fails closed.
- [x] Verified against the real vault: `walk` of the projects directory returned 15
      files, `skippedSymlinks: 1`, and all 4 `index.md` — matching a direct disk read.

**Completeness and accounting.** Nothing noticed that a record class had gone,
because `source-empty` only fires when *total* records are zero and 271 events kept
it quiet. "Some records exist" is not evidence that the source was read.

- [x] Per-kind scan status: `complete`, `absent`, or `failed`. A failed canonical
      scan blocks the baseline — "I could not look" is a different claim from
      "I looked and found nothing".
- [x] `directory-unreadable` is now **error** severity when the directory exists but
      could not be traversed, and warning only when it is genuinely absent. Reporting
      traversal failure as a warning is precisely how a whole class vanished into a
      passing baseline.
- [x] Per-kind census: scanned files, record candidates, loaded, explicitly rejected,
      unaccounted. `recordCandidates === loadedRecords + explicitlyRejected`, and any
      unaccounted candidate aborts the run.
- [x] Only a candidate that never became a record counts as rejected. A warning on a
      loaded record — defaulted enum, missing relationship — does not.
- [x] Zero records for a class whose complete scan genuinely found zero candidates
      remains legal.
- [x] Regressions in `tests/transportCompleteness.test.ts`: a dangling link beside a
      real `index.md` loads both projects (0 before the fix), bridge and direct disk
      reads agree, duplicate ids reconcile as 2 candidates → 1 loaded + 1 rejected,
      and absent directories stay legal while unreadable ones block. Windows junctions
      stand in for symlinks, which need a privilege an ordinary process lacks; Node
      reports both through `isSymbolicLink()`, so the traversal path is identical.

**Re-run against the real vault, after both fixes:** layout `legacy`, all three scans
`complete`, projects 15 scanned → 4 candidates → 4 loaded → 0 unaccounted, tasks
genuinely empty, events 271 → 271 → 271, zero blockers. This now matches the direct
disk read exactly. The 238 `warning:missing-project` problems are real vault state —
events referencing project folders that hold no `index.md` — recorded as evidence and
not tuned around. The creator's vault was not modified.

### 6.1S Candidate outcomes and definitive absence (Gate 6Q.1a)

Two holes the audit found in the first accounting attempt, both able to recreate the
false-PASS class.

- [x] Rejections are counted where the candidate's outcome is decided, not from a
      problem-array snapshot taken afterwards. `unreadable` and the project
      `unexpected-type` veto are both raised during the scan, so a post-scan slice
      missed them and reported a phantom unaccounted candidate — reproduced, then
      fixed. Broadening the slice was rejected as the repair: unrelated later problems
      would then be miscounted as candidate rejections.
- [x] All three rejection classes reconcile: discovery veto, unreadable candidate,
      and post-scan identity collision.
- [x] A warning on a record that did load is still not a rejection.
- [x] Absence is proved, never inferred. `VaultReader.presence` is an optional probe
      answering `present | missing | unknown`; a reader without one answers `unknown`,
      which blocks. Inferring absence from a second failed directory operation — the
      previous implementation — made a permission-denied directory indistinguishable
      from one that was not there.
- [x] Present-but-unreadable ⇒ `failed`, error severity, blocking. Genuinely missing
      ⇒ `absent`, warning, legal. Unknown ⇒ `failed`.
- [x] The bridge answers presence from errno: `ENOENT`/`ENOTDIR` ⇒ missing,
      `EACCES`/`EPERM` ⇒ present, anything else ⇒ unknown.
- [x] `presence` is part of the zero-write read surface. Omitting it did not make the
      witness stricter, it made it wrong: the probe was refused, so every missing
      directory became an unreadable one.
- [x] `npm test` now builds first. Two tests had been passing against stale compiled
      modules, which is how a fix could look verified while the harness exercised
      older code.

**Real-vault run against the corrected build:** status PASS, layout `legacy`, zero
blockers, all thirteen stages PASS. projects 15 scanned → 4 candidates → 4 loaded →
0 unaccounted; tasks complete and genuinely empty; events 271 → 271 → 271. Matches a
direct disk read exactly. 238 `warning:missing-project` remain as recorded evidence.
Vault unmodified.

### 6.1T Bridge presence propagation (Gate 6Q.1b)

The bridge answered presence correctly and the loader consumed it correctly, but the
capability reached the reader only because the harness patched it on after
construction. A capability bolted on outside the adapter is one the browser path
silently lacks, and one that can vanish without any test noticing.

- [x] `createHttpPresenceProbe` queries `/api/vault/presence` and is loopback-checked
      before any request.
- [x] The probe travels as an `OpfsVaultOptions` field through
      `createHttpDirectoryHandle` → `createExternalDirectoryVault` → `createOpfsVault`
      and appears as `VaultReader.presence`.
- [x] A source that cannot answer is never made to invent one: without a probe the
      reader has no `presence` at all, and the loader fails closed on the silence.
      Generic OPFS/FSA handles have only traversal, which cannot separate missing
      from unreadable.
- [x] Only `present` and `missing` are believed; an unrecognised value, a non-OK
      response, or a transport error allanswer `unknown`.
- [x] The zero-write witness records a presence call as a read.
- [x] The harness no longer patches the reader; it passes the probe as an option.
- [x] Regression exercises the real bridge-backed chain end to end: a vault holding
      only events reports project and task `absent`, event `complete`, and passes.

**Standing process requirement, at the reviewer's direction:** `npm test` builds
first. Stale compiled modules were letting tests pass against old behaviour, so
build-before-test is an invariant of this repository's acceptance work rather than a
convenience.

### 6.1U Gate 6R — real Obsidian coexistence (signed)

**Signed PASS at `abf99364`**, with substages split rather than bundled:

| substage | verdict |
| --- | --- |
| external edit, create, modify, delete | PASS |
| **rename** | **PASS at `fff4fee`** — disposable external-directory peer rename preserves record identity/provenance and is zero-write; actual Obsidian/Papers-hosted rename remains unclaimed |
| obsidianCoexistence | PASS for create/modify/delete |
| Proxima zero-write | PASS |
| cleanup | PASS |
| human-authored edit | **not claimed** |
| Papers-hosted coexistence | OPEN |

Recorded caveats, neither blocking:

- Obsidian was launched with no explicit vault argument; the root was prevalidated
  against Obsidian's own registry requiring `open === true` and an exact normalised
  match. The claim is *not* that the executable was instructed to open that root.
- The vault has `remotely-save` installed, so the transient probe record was
  potentially visible to another sync plugin during the run. It was not disabled,
  because disabling it would itself modify the creator's environment and add a
  variable. The gate therefore proves Obsidian-mediated mutation and Proxima
  observation, **not** isolation from other installed vault software.
- The probe's create step can recover from a create conflict by modifying. Future
  probes should report `create-conflict-recovery` distinctly rather than folding it
  into `create`.

**Standing rule for any future gate that temporarily modifies the creator's
environment:** a disposable dry run comes first, and it must exercise the failure
paths that threaten cleanup — launcher missing, launcher dies immediately, plugin
never loads, plugin loads but never completes, process hangs, mutation throws,
observation throws, cleanup itself partially fails. The goal is not a happy path on
a copy; it is proving that *every* failure path either leaves the creator vault
untouched or reaches deterministic cleanup. An unhandled spawn error skipping the
restore step is what made this rule necessary.

### 6.1V Live surface against a legacy vault

Found by pointing the built page at the real vault through the bridge, which no
fixture had exercised:

- [x] Startup activation detects the layout instead of assuming the preferred one.
      A legacy vault previously looked empty, failed activation, and fell back to
      fixture bytes without saying why.
- [x] Refreshes reuse the layout that produced the state. Without it a legacy vault
      read correctly at startup and then went `SOURCE DEGRADED` with
      `directory-unreadable` on the first refresh, about a vault that had not changed.
- [x] The hydration summary reports the true source mode. It previously said
      `mode: fixture` unconditionally, so a page serving the creator's real vault
      described itself as bundled fixture bytes — wrong in the one direction that
      matters for an agent deciding whether data is disposable.
- [x] `tools/serve-public.mjs` serves `public/` on loopback, GET only, confined to
      that directory, so the built page can be looked at outside Papers.

### 7 Excalidraw display

**7A real artifact discovery — PASS at `f5a3364`.** The vault holds exactly two real
Excalidraw artifacts, both Obsidian-plugin envelopes, read through the audited
bridge path. No synthetic artifact substituted for the real-vault evidence.

**7B structural recognition — PASS at `f5a3364`.** Recognition is by structure, never
by filename.

**7C decoding — implemented.**

- [x] Upstream LZ-String decompression core vendored from 1.5.0 in
      `src/domain/excalidraw-lz-string.ts` (WTFPL header preserved); the Proxima wrapper
      adds bounded input validation, TypeScript types and fail-closed normalization.
      This is decompression-only — Proxima does not write drawings, so it carries no
      compressor. Vendored rather than depended upon because the build is tsc-only with
      no bundler and the Papers CSP forbids fetching anything at runtime; the code has
      to be in the build output.
- [x] Not reimplemented. A hand-written LZ decoder is the kind of deceptively small
      compatibility task that yields "works on my sample" corruption, and corruption
      here renders a drawing nobody made.
- [x] Both real creator drawings decode through the ordinary entry point with zero
      problems: 117 elements (freedraw, text, image) and 289 elements (image,
      freedraw, line, text, arrow), `type: excalidraw`, version 2.
- [x] A decoder failure returns null rather than a partial string, and surfaces as a
      bounded `decode-failed`; garbage that decodes to non-JSON surfaces as
      `payload-unparsable`. Neither produces a scene.
- [x] Tests use a genuinely LZ-String-compressed payload produced by the upstream
      compressor and wrapped across lines as the plugin wraps its own — a synthetic
      "looks compressed" string would prove nothing about the algorithm.
- [x] Geometry, text, connector bindings, appState and element order (z-order) all
      verified preserved through the decode.
- [x] The envelope summary still reads when the scene cannot be decoded, so a canvas
      has something honest to show for an undecodable drawing.
**7C rendering — implemented.**

- [x] Pure SVG renderer: scene plus already-resolved assets in, SVG and census out.
      No DOM, no filesystem, no Obsidian. Acquiring asset bytes is a different trust
      boundary and belongs to the resolver.
- [x] Supported types are exactly those the creator's drawings contain — freedraw,
      text, line, arrow, image. Rendering types nobody has would be untested code
      pretending to be capability.
- [x] **Nothing disappears without a reason.** `rendered + unsupported + deleted +
      skipped === sceneElements`. This caught a real omission: Excalidraw tombstones
      (`isDeleted`) were being skipped silently, leaving six of 289 elements
      unexplained in a census reporting zero unsupported.
- [x] An unsupported type is a bounded diagnostic carrying type and count, never a
      silent drop; the supported remainder still renders.
- [x] An image without a resolved asset renders a visible, labelled placeholder plus
      `image-asset-unresolved`. A missing image must not read as empty canvas.
- [x] Element order preserved as z-order; framing derived from the drawing's own
      extent; element text escaped so content cannot escape into markup.
- [x] The scene's background is reported, not substituted. `transparent` is a real
      answer — painting white would invent a decision the artist did not make — so
      the surface supplies its own sheet.
- [x] Bounded element and point budgets are explicit diagnostics: elements beyond
      the scene limit and point-based geometry beyond the point limit are counted as
      skipped rather than silently omitted.
- [x] Both real drawings render: 117 elements all drawn, and 289 elements with 283
      drawn, 6 deleted, 0 unsupported. One image placeholder each.

**7D asset resolution — resolver and bounded byte loading implemented.**

- [x] A narrow resolver, not Obsidian link semantics. Block and heading references,
      aliases beyond the display half, metadata resolution, `.obsidian` config, URI
      schemes, network URLs and external paths are all rejected rather than
      implemented — implementing them speculatively is how a narrow adapter becomes
      the compatibility layer this project exists to escape.
- [x] Pure and index-driven. The vault index comes from the audited read-only source;
      a resolver that searched the filesystem itself would recreate the semantics it
      is meant to avoid.
- [x] Four distinct answers: resolved, unresolved, ambiguous, rejected. Unresolved
      and ambiguous are **not** collapsed — nothing matching is a different problem
      from a reference too vague to identify one file, and they need different fixes.
- [x] An ambiguous link selects nothing. Index order is not a decision about which
      file the artist meant, and a confidently wrong image is worse than a visible gap.
- [x] Verified against the real vault, index of 4,074 entries:
      `[[Pasted Image 20260605223658_755.png]]` → resolved to
      `-Hide/Attachments/Pasted Image 20260605223658_755.png`;
      `[[Ôn sử đảng]]` → unresolved, zero matches.
- [x] Two defects found by the tests and fixed: a caret check that only looked at the
      start let `[[Note^block]]` through as an ordinary name, and `[[]]` fell out of
      the wikilink pattern and survived as a literal target reported merely as
      unresolved.
- [x] **Load the resolved bytes.** `VaultReader.readBinary` returns bounded bytes,
      validates media by signature, records provenance and per-asset outcomes, and
      refuses unsupported media without spending a hidden/unaccounted read budget.
      `VaultReader.read` returns text, and reading a PNG
      as UTF-8 corrupts it, so turning a resolved attachment into an actual rendered
      image uses the binary capability on the port.

- [ ] (superseded) 7D asset resolution — embeds are recorded as links. The
      vault supplies both cases naturally: one embed resolves to
      `-Hide/Attachments/Pasted Image 20260605223658_755.png`, and the other,
      `[[Ôn sử đảng]]`, is **dangling** — no such file exists anywhere in the vault.
      So the missing-asset path has real evidence, not a synthetic fixture.
      `scene.files` is empty in both drawings, confirming the bytes live outside the
      scene as vault attachments.

**7F re-asserted after decoding:** fingerprinting the whole vault before and after
decoding both real drawings reports no changed paths.

### Audit invariant — self-description integrity

Promoted from the `mode: fixture` defect, which was a trust-boundary failure rather
than a display bug: the page reported *disposable fixture* while serving the
creator's real vault, which is exactly backwards from what an agent-control surface
must tolerate.

Every machine-readable claim about source mode, source identity, generation,
fixture-versus-live status, read-only-versus-writable, health, provenance, build
identity or capability availability must be derived from the same authoritative
state the application itself uses. The UI must not manufacture a second truth.
Tests must prove that switching the underlying state cannot leave the description
stale or contradictory — in particular across fixture→external, external→fixture,
external→degraded, external→recovered and external→deleted.

### Gate 7 verdicts — re-audited and signed

The current ChatGPT browser reviewer re-audited the exact pushed tree at
`a9f69ad7ebe6215a47437dca5e1dc8d6597f555e` on 2026-09-07. The audit covered the
full 7A–7D sequence, including the fail-closed embedded-file parser boundary, and
found no implementation regression or compatibility blocker. The work, tests and
real-vault evidence stand on their own — whole-vault fingerprints unchanged and the
creator's drawings demonstrably rendering — while the reviewer supplies the
independent sign-off. The legacy 7.1–7.5 plan below is retained as historical
context; the implemented direct-source route is the signed compatibility contract.

Gates through 6R remain signed: those verdicts predate the reported switch.

### Signed gate ledger (as of 2026-09-07)

| Gate | Status | SHA |
| --- | --- | --- |
| 6Q real creator-vault read-only baseline | PASS | `82c3f9a6` |
| 6R Obsidian coexistence — create / modify / delete | PASS | `abf99364` |
| 6R external **rename** | PASS (disposable external-directory acceptance; host/Obsidian rename unclaimed) | `fff4fee` |
| 7A real Excalidraw discovery | PASS | `a9f69ad7` |
| 7B structural recognition | PASS | `a9f69ad7` |
| 7C compressed-json decoding | PASS | `a9f69ad7` |
| 7C SVG rendering | PASS | `a9f69ad7` |
| 7D link resolution | PASS | `a9f69ad7` |
| 7D binary assets + real-artifact acceptance | PASS | `a9f69ad7` |
| 7A–7D overall | PASS | `a9f69ad7` |
| Object-URL lifecycle | deferred to the browser viewer | — |
| Native FSA, clean-profile picker, Papers-hosted acceptance, write/concurrency | OPEN | — |

The `Uint8Array` → data-URL choice was accepted over Blob/object URLs: the loader
lives in `src/app`, which compiles with no DOM types, and acquiring a browser
dependency there to satisfy a presentation preference would be the wrong trade.
Presentation conversion belongs to the surface, and the URL lifecycle becomes real —
and testable — only when a drawing viewer exists.

### Gate 8 — arbitrary-file canvas (next)

    any vault file → safe source read → canvas node → appropriate representation

Excalidraw becomes one specialised representation among many: drawing, Markdown
document card, image card, code card, and a fallback file card for the unknown. The
browser drawing viewer is part of this surface work rather than a separate gate,
because that is where the object-URL lifecycle finally becomes real — mount, create
presentation URL, render, replace/unmount, revoke.

**The binary capability must not widen here.** `readBinary` existing does not mean
the canvas may load arbitrary files however it likes. The same policy holds:
vault-relative paths only, no traversal, no symlink following, bounded bytes, an
explicit media policy, provenance and source revision, per-node failure, and no
filesystem authority in the UI or the domain. The canvas consumes the audited source
abstraction exactly as Excalidraw does.

### 6.2 Elastic board

- [x] Correct projects available — active task-project set and inactive-selection
      reconciliation are covered by `tests/boardDerivation.test.ts` (6.2A, `fa02b06`).
- [x] Correct task filtering — all, uncategorised, selected-project and
      schedule-project exclusion are covered by `tests/boardDerivation.test.ts`
      (6.2A, `fa02b06`).
- [x] Correct three-column derivation — `backlog`/`running`/`finished` mapping is
      covered by the selector and Elastic tests (6.2A, `fa02b06`).
- [x] Ordering preserved — numeric `orderIndex` sorting and stable ties are pinned by
      `tests/boardDerivation.test.ts` (6.2A, `fa02b06`).
- [x] Elastic heights match pinned domain timeline — `tests/elastic.test.ts` and
      `tests/boardElasticPresentation.test.ts` (Gate 6.2B, `6e58f8f`).
- [x] Fixed-duration behavior visible — fixed allocation is reflected in running-card
      minimum heights (Gate 6.2B, `6e58f8f`).
- [x] `maxDuration` cap behavior visible — capped allocation is reflected in running-card
      minimum heights (Gate 6.2B, `6e58f8f`).
- [x] Expired deadline behavior visible — expired/equal work is marked `Overdue` and
      uses the defined weight fallback, including mixed expired/future deadlines (Gate
      6.2B, `6e58f8f`).
- [x] No mutation to real vault — the Gate 6.5A read-only authority boundary and
      zero-write evidence apply to the Board surface (Gate 6.5B, `57f1e20`).

### 6.3 Calendar

- [x] Task/schedule project separation correct — active schedule eligibility,
      task/archived exclusion, and all/uncategorised/selected filtering are pinned by
      `tests/calendarDerivation.test.ts` (6.3A, `95188f8`).
- [x] Multi-day events render across all covered days — inclusive local-day bucketing,
      reversed/invalid-end fallback, and the exact 36,600-day fail-closed bound are
      pinned by `tests/calendarDerivation.test.ts` (6.3A, `95188f8`).
- [x] Calendar navigation deterministic — canonical integer month arithmetic, bounded
      `0000`–`9999` no-op edges, and low-year-safe 42-cell rendering are pinned by
      `tests/actionProtocol.test.ts` and `tests/calendarGrid.test.ts` (6.3B,
      `5af0c66` + `381a294`).
- [x] Invalid events surface safely — strict date validation yields bounded `bad-date`
      diagnostics, invalid starts receive no bucket, and invalid/reversed ends plus
      over-limit spans fail visibly (6.3C, `2fd66b6` + `6828664`).
- [x] Timezone behavior matches chosen semantics — date-only values are literal civil
      dates; explicit timestamps/offsets use viewer-local day conversion (D10,
      6.3C, `2fd66b6`).
- [x] No mutation to real vault — the Gate 6.5A read-only authority boundary and
      zero-write evidence apply to the Calendar surface (Gate 6.5B, `57f1e20`).

### 6.4 Projects

- [x] Flat and subfolder legacy projects display correctly — ingestion and the
      read-only project navigation are pinned by `tests/projectIngestion.test.ts`
      and `tests/projectPresentation.test.ts` (Gate 6.4A/6.4B, `629c856` +
      `97b09da`).
- [x] Project description/body reads and displays correctly — absent description,
      nonempty precedence and explicit-empty suppression are pinned at ingestion;
      selected project details display the resulting value (Gate 6.4A/6.4B,
      `629c856` + `97b09da`).
- [x] Linked folders display correctly — singular, preferred array and packed legacy
      forms with exact-path deduplication are pinned and rendered read-only (Gate
      6.4A/6.4B, `629c856` + `97b09da`).
- [x] Archived state displays correctly if retained — archived records remain in
      state and are visibly labelled in the project inventory (Gate 6.4A/6.4B,
      `629c856` + `97b09da`).
- [x] Project source provenance available for diagnostics/opening later — source path
      and ID origin are shown as read-only metadata; opening/reveal remains a future
      capability (Gate 6.4A/6.4B, `629c856` + `97b09da`).

### 6.5 Real-vault safety

- [x] No writer implementation wired — `VaultWriter` is not reachable from the
      browser/source-session/action graph; zero-write witness tests enforce the
      capability boundary (Gate 6.5A, `8a53fbd` + follow-up).
- [x] No hidden write through browser APIs — external/FSA/bridge adapters expose
      read-only paths to Proxima (Gate 6.5A, existing zero-write and acceptance
      suites).
- [x] No migration on boot — startup restores or reads a source and does not write
      migration state (Gate 6.5A, existing startup/acceptance suites).
- [x] No auto-fix of frontmatter — malformed fields become bounded diagnostics and
      are never rewritten (Gate 6.5A, existing validation/zero-write suites).
- [x] No destructive product/semantic agent commands against a creator vault — the
      explicitly invoked `agent:coexist` harness is a separately scoped acceptance
      tool whose peer writes are authorized, declared and verified; it is not a
      Proxima product action (Gate 6.5A, `8a53fbd` + coexistence evidence).
- [x] Fixture mode remains the default mutable automation environment — source-mode
      boot metadata is now owned by resolved source state and cannot be overwritten
      by lifecycle transitions (Gate 6.5A, follow-up boot-state regression).

---

## Gate 7 — Excalidraw display compatibility

### Defined compatibility contract (current implementation)

- **Level A — display/reference fidelity: PASS** for the audited creator-vault
  subset and supported scene/asset types, through the direct source parse → bounded
  pure SVG render route.
- **Level B — core editing/round-trip: DEFERRED** to later write/editing work.
- **Level C — broad Obsidian Excalidraw plugin compatibility: NOT CLAIMED.**

The auto-export/embedded upstream-editor-runtime route described in parts of the
historical plan below is **not chosen / superseded** by the signed direct-source
route. Unsupported scene constructs remain fail-visible rather than silently
discarded.

### 7.1 Compatibility levels explicitly separated

- [ ] A — display/reference fidelity
- [ ] B — core Excalidraw editing/round-trip
- [ ] C — broad Obsidian Excalidraw plugin compatibility

Initial target:

- [ ] A required
- [ ] B experimental/selective
- [ ] C explicitly not assumed

### 7.2 Auto-export display route

- [ ] Representative `.excalidraw.md` created in real Obsidian.
- [ ] Obsidian Excalidraw auto-export SVG enabled/tested.
- [ ] PNG export tested if needed.
- [ ] Proxima locates associated export safely.
- [ ] SVG displayed in Proxima.
- [ ] PNG displayed in Proxima.
- [ ] Source `.excalidraw.md` remains canonical.
- [ ] Obsidian plugin continues to edit normally.
- [ ] External edit/export refresh reflected in Proxima.

### 7.3 Raw `.excalidraw`

- [ ] Representative raw scene fixture.
- [ ] Parse scene JSON.
- [ ] Render using upstream Excalidraw where chosen.
- [ ] Embedded images covered.
- [ ] Fonts covered.
- [ ] Large scene behavior bounded.

### 7.4 `.excalidraw.md` adapter

- [ ] Detect Markdown drawing format.
- [ ] Locate Excalidraw data section.
- [ ] Support plain JSON form if present.
- [ ] Support compressed JSON form if required.
- [ ] Preserve source Markdown structure in any future round-trip.
- [ ] Do not copy AGPL plugin implementation casually into incompatible licensing.
- [ ] Treat plugin-specific links/transclusions separately from core scene
      compatibility.

### 7.5 CSP compatibility matrix

Test before changing Papers.

- [ ] core library boots
- [ ] CSS loads
- [ ] bundled/self-hosted fonts load
- [ ] images load
- [ ] blob image flows tested
- [ ] workers tested
- [ ] WASM/font-subsetting path tested
- [ ] external network features remain intentionally blocked
- [ ] iframe/web embeds remain intentionally blocked unless separately justified

For each failure:

- [ ] record exact browser/CSP failure
- [ ] prove feature is required
- [ ] request only smallest CSP change if needed

No speculative broadening of `connect-src`.

---

## Gate 8 — Arbitrary-file canvas model

### 8.1 Core canvas object model

- [x] Canvas node identity is Proxima-owned and stable.
- [x] Node identity is not renderer type.
- [ ] Node can reference:
  - [x] vault file
  - [ ] granted external file
  - [ ] directory if supported
- [x] Source locator/provenance is distinct from canvas node ID.
- [x] Position/layout independent of source path.
- [x] Rename/delete behavior specified.
- [x] Missing source remains a representable canvas state.

### 8.2 Renderer registry

- [x] Markdown/text selection
- [x] PNG/JPEG/WebP selection by byte signature
- [ ] SVG (deferred passive policy)
- [x] Excalidraw selection by structure
- [ ] PDF if later added
- [x] unknown file fallback
- [x] no arbitrary executable HTML/JS simply because a file was dropped

### 8.3 "Any file" contract

- [x] Every admitted creator-selected browser file can exist as a canvas object (ephemeral one-shot source).
- [x] Only understood formats require inline preview (supported raster, Excalidraw scenes and literal text; SVG/PDF remain passive).
- [x] Unsupported format gets a first-class fallback card, rendered visibly on Canvas.
- [x] Fallback card can show available:
  - [x] filename
  - [x] extension
  - [x] size
  - [x] modified time
- [x] icon/thumbnail (static local category token; no source-derived thumbnail)
  - [x] missing/unavailable state
- [x] Unsupported file is not treated as error just because no renderer exists.

### 8.4 Drag/drop

- [x] Browser raster, decoded Excalidraw scene and supported text/Markdown drops can be previewed one-shot from `File`.
- [x] Source identity semantics after restart specified for ephemeral admission.
- [x] Dropped path-like metadata does not become a vault locator or logical ID.
- [x] Duplicate drops have defined behavior: each admission is independent.
- [x] Large file bounds exist before one-shot content acquisition.
- [x] Active/executable content remains passive and is skipped before acquisition.

### 8.5 Bounded source loader

- [x] Canvas loader validates vault-relative paths before any read.
- [x] Active-content extensions are skipped without source I/O.
- [x] Text reads receive the selector character bound.
- [x] Binary reads use the optional bounded `readBinary` seam.
- [x] Read-time path/revision/size/modified metadata reaches selection unchanged.
- [x] Missing binary capability and read failure become explicit fallback outcomes.
- [x] Loader preserves Proxima-owned node identity and layout.
- [x] Browser `File` one-shot admission is bounded and capability-free after acquisition.
- [x] Inline browser raster/object-URL lifecycle, scene-only Excalidraw SVG rendering and escaped literal text rendering (SVG/PDF remain open).

---

## Gate 9 — Native open/reveal handoff

Only if product UX requires it.

### 9.1 Acceptance failure first

- [ ] creator can see unsupported/external file in Proxima;
- [ ] browser-only Proxima cannot reliably open that exact source in its native/default
      app or reveal it in Explorer.

### 9.2 Smallest host capability

Papers should know only:

- [ ] exact authenticated Backpack
- [ ] opaque granted file/source reference
- [ ] `open`
- [ ] `reveal`

Papers must not know:

- [ ] project
- [ ] task
- [ ] canvas semantic type
- [ ] Excalidraw
- [ ] Obsidian

### 9.3 Acceptance

- [ ] Open exact source in default/native app.
- [ ] Reveal exact source in Explorer.
- [ ] Unauthorized source rejected.
- [ ] Stale source rejected safely.
- [ ] Capability scoped to owning Backpack.
- [ ] No arbitrary ungranted machine path escalation.

---

## Gate 10 — Live agent control through Papers

Only when Proxima's own action/inspection contract already exists.

### 10.1 Prove current gap

- [ ] `papers_control` can target the live surface.
- [ ] C1 can inspect/capture it.
- [ ] There is no semantic path to call Proxima actions.
- [ ] There is no semantic path to inspect Proxima-owned state.
- [ ] Arbitrary renderer JavaScript would violate the intended control-plane design.

### 10.2 Smallest host truth

> "An authenticated Papers developer-control connection has no bounded semantic
> request/response route to an explicitly named live Backpack surface."

### 10.3 Dev-only relay requirements

If a Papers change is authorized:

- [ ] only active under `PAPERS_DEV_CONTROL`
- [ ] explicit `windowId`
- [ ] explicit `surfaceId`
- [ ] exact live target validation
- [ ] bounded request size
- [ ] bounded response size
- [ ] request ID
- [ ] timeout/cancellation
- [ ] project-defined opaque method name
- [ ] schema/version field
- [ ] no selectors
- [ ] no JavaScript source/eval
- [ ] no fabricated renderer sender identity
- [ ] no Proxima semantics inside Papers
- [ ] project receives request through fixed structured channel
- [ ] result travels back through same authenticated request
- [ ] page cannot address another project/surface

### 10.4 Proxima side

- [ ] Live control handler maps requests into existing Proxima action dispatcher.
- [ ] Inspection maps to existing state projection.
- [ ] Event retrieval maps to existing event ring.
- [ ] UI and agent still use same application semantics.
- [ ] Real creator vault stays read-only by policy.
- [ ] Destructive/mutating agent operations restricted to fixture mode unless separately
      authorized.

---

## Gate 11 — Full agent scenario harness

### 11.1 Fixture scenarios

- [ ] boot fixture
- [ ] select project
- [ ] switch board/calendar
- [ ] inspect Elastic distribution
- [ ] verify fixed-duration task
- [ ] verify capped task
- [ ] verify uncategorised record
- [ ] verify multi-day event
- [ ] simulate external file revision
- [ ] simulate rename/delete
- [ ] unsupported frontmatter
- [ ] duplicate ID
- [ ] malformed date/numeric field
- [ ] Excalidraw display fixture
- [ ] arbitrary unsupported file node

### 11.2 Scenario execution

Each scenario:

- [ ] starts from known fixture hash
- [ ] resets deterministic clock
- [ ] resets deterministic IDs
- [ ] records starting state revision
- [ ] issues semantic actions
- [ ] waits on semantic settled state
- [ ] reads event sequence
- [ ] asserts domain state
- [ ] asks Papers C1 for visual stability
- [ ] runs visual assertions
- [ ] captures relevant elements/surface
- [ ] records diagnostics
- [ ] emits machine-readable evidence

### 11.3 No meaningless mocks

- [ ] Domain tests use actual representative file bytes.
- [ ] Disk integration uses actual directories.
- [ ] Browser filesystem tests use real browser filesystem primitives.
- [ ] Real FSA acceptance uses disposable actual Windows directories.
- [ ] Real Obsidian acceptance remains small but genuine.
- [ ] Mock-only success cannot sign off vault compatibility.

---

## Gate 12 — External-change convergence

Before introducing writes.

### 12.1 Read refresh

- [x] Detect or discover changed revision — refresh revisions and source generations
      are pinned by the refresh-controller/integration suites.
- [x] Reload changed file — accepted refreshes rebuild one bounded projection.
- [x] Update domain state — dispatcher replacement applies the accepted projection
      atomically.
- [x] Maintain selection where identity survives — selection reconciliation is
      covered across refresh and deletion cases.
- [x] Handle source rename — explicit-ID continuity and disposable external rename
      acceptance are pinned by `tests/obsidianCoexistence.test.ts` (Gate 6R).
- [x] Handle source deletion — deletion removes the visible record and safely
      reconciles selection in refresh integration.
- [x] Handle newly created records — external acceptance and refresh integration
      cover discovery on the next refresh.
- [x] Handle temporarily malformed file while Obsidian/plugin is saving — last-good
      projection is retained and health becomes stale/degraded.
- [x] Never partially merge malformed source into confirmed state — projection
      replacement is generation-atomic and recovery is separately tested.

### 12.2 Refresh strategy decision

- [x] refresh-on-focus — browser focus wiring converges on the normal refresh path.
- [x] explicit refresh — the stable `source-refresh` control routes through policy.
- [x] bounded polling — visibility-aware interval policy is bounded, idempotent and
      disposable.
- [x] browser watcher availability if any — no native watcher is required for the
      current pull-refresh contract; browser lifecycle triggers are the chosen strategy.

Only request host watch support if a concrete acceptance requirement fails.
Possible missing truth:

> "Proxima cannot receive sufficiently timely notification that a granted external file
> changed using available browser mechanisms."

### 12.3 Watch capability if justified

- [ ] project-scoped
- [ ] granted root only
- [ ] create/change/delete/rename semantics documented
- [ ] bounded event rate
- [ ] overflow/reconciliation behavior
- [ ] symlink/junction escape protections
- [ ] no Proxima-specific semantics in Papers

---

## Gate 13 — Owner-mode mutation engine (fixture/disposable only)

This gate builds the complete programmatic mutation substrate without granting writes
to the creator's real vault. No UI interaction is required to drive it.

### 13.0 First implementation slice

- [x] Byte-based conditional writer contract (`VaultWriter`) defines create, update,
      move and delete operations with explicit revision/absence preconditions.
- [x] Memory adapter implements deterministic conditional create/update/move/delete.
- [x] Mutation coordinator canonicalizes vault-relative paths, enforces byte limits,
      serializes operations per root and emits bounded lifecycle events.
- [x] Coordinator refuses stale/missing/occupied targets without automatic retries.
- [x] Bounded in-memory recovery records are captured before destructive operations.
- [x] Disposable real-disk writer implements the same contract and measured race
      semantics.
- [x] Independent-writer race and conditional recovery-restore suites pass; Obsidian
      coexistence remains a separate native integration gate.
- [ ] Creator-vault/native-FSA mutation authority remains disabled.

> **Later resolution:** Gate 13.3 below closes this as an explicit safety NO-GO rather
> than an unfinished writer task. The mutation substrate exists; native FSA
> creator-vault authority remains disabled because the available commit primitive is
> non-atomic. See D51.

### 13.B Adversarial commit and recovery status

- [x] Forced external edit between revision check and update is refused without
      overwriting peer bytes (disposable disk barrier test).
- [x] Forced external edit between revision check and delete is refused.
- [x] Forced external destination creation during move is refused.
- [x] Create remains exclusive under a competing creator.
- [x] Mutation path/byte bounds and traversal rejection are enforced.
- [x] Every attempted mutation has one request ID and one terminal bounded event.
- [x] Durable recovery journal survives process termination.
- [x] Crash injection and conditional recovery restore are verified.
- [ ] Independent Obsidian writer coexistence is verified for write operations.
- [ ] Exact residual filesystem race semantics are documented for native/FSA adapters.

> **Superseded by later Gate 13 evidence:** 13D2 closes the actual
> Obsidian-versus-Proxima conditional-write concurrency claim, and 13.3 classifies the
> residual native FSA check-to-commit race as unacceptable and closes native writes
> NO-GO. These original boxes remain unchanged as the state recorded at this earlier
> Gate 13.B checkpoint.

### 13.C Crash-durable recovery journal

- [x] Recovery abstraction records request ID, operation, relative path, revision and
      bounded prior bytes, with prepared/committed state support.
- [x] A disk-backed journal survives process termination (child-process write/restart
      load test).
- [x] Process-kill injection classifies prepared, committing and committed states.
- [x] Interrupted update/delete/move recovery is conflict-aware and idempotent.
- [x] Recovery refuses to overwrite newer peer bytes or delete a peer destination.
- [x] Journal retention and recovery payload limits remain bounded.

### 13.C2 Mutation-phase crash reconciliation

- [x] Prepared entries are reconciled against actual filesystem state after restart.
- [x] Update/delete/move committed-vs-unmodified states are classified without blind
      rollback; ambiguous peer changes become blocked.
- [x] Reconciliation is idempotent and emits machine-readable outcomes.
- [x] Actual process-kill injection at each filesystem mutation phase is verified.
- [ ] Automatic startup reconciliation is wired into the Papers runtime.

### 13.C2 prepared-record classification

- [x] Prepared update/delete/move records are classified read-only as not-applied,
      effect-present, conflict or already-committed.
- [x] Intended update fingerprints and prior byte fingerprints are persisted.
- [x] Binary-capable readers are used for exact-byte preimages when available.
- [x] Reconciliation never restores or mutates source files.
- [x] Ambiguous source/destination states fail closed as conflict.
- [x] Delete/update/move unreadable sources or destinations fail closed as conflict.
- [x] Classification compares bounded exact bytes; fingerprints are advisory only.
- [x] Durable reload preserves prior/intended byte evidence needed for classification.
- [x] Host-neutral automatic startup reconciliation and conditional status transitions
      are implemented and tested; runtime wiring remains open.

### 13.C2B Real process-death mutation phases

- [x] Child-process crash scenarios cover update, delete and move before mutation and
      after filesystem commit; parent reloads the durable journal and classifies without
      rollback.
- [x] Prepared-before-mutation state is `not-applied`; committed filesystem effects
      are `effect-present`.
- [x] Parent classification performs no writes and repeated classification is stable.
- [x] Crash before writer, after filesystem commit, and after durable
      `markCommitted` are exercised against the built mutation coordinator and
      disposable disk writer; the parent reloads and classifies each phase.
- [x] Parent restart can reconcile effect-present, not-applied and conflict states
      into durable committed/recovered/blocked statuses without touching vault bytes.
- [ ] Runtime wiring into the Papers startup session remains open.

### 13.C3 Autonomous startup recovery and conditional restore

- [x] Startup loads the bounded durable journal before owner-mode mutation authority.
- [x] Every prepared/recovery-required record is classified before authority is
      available; effect-present commits, not-applied recovers/no-ops, and conflicts
      block durably.
- [x] Malformed/unreadable journal or source state fails closed and blocks authority.
- [x] Repeated startup reconciliation is idempotent with bounded machine-readable
      outcomes and no vault writes.
- [x] Committed update/delete/move records have agent-callable conditional restore
      using only CAS writer methods.
- [x] Peer edits, peer recreation, destination changes and unreadable states refuse
      restore; successful restore is durably marked recovered.
- [ ] Papers runtime wires startup reconciliation before exposing owner-mode writes.
- [ ] Native creator-vault/FSA restore and Obsidian coexistence remain open.

### 13.D1 Disposable multi-writer coexistence

- [x] Proxima create/update/move/delete run through `createVaultMutationCoordinator`
      and the disposable disk `VaultWriter`; destructive records finalize durably.
- [x] Independent peer process edits unrelated bytes while Proxima commits; unrelated
      and `.obsidian`-equivalent metadata remain intact.
- [x] Deterministic peer edit and destination-creation races return stale/conflict
      without overwriting peer bytes.
- [x] Conditional update/delete/move restore refuses peer-modified target state.
- [x] Peer activity is programmatic and barrier-driven; no UI or creator interaction
      is required for the disposable gate.
- [x] Full source rename/delete race matrix and machine-readable bounded tree-diff
      attribution cover peer source disappearance without automatic recreation.
- [ ] Actual Obsidian application against a disposable vault remains Gate 13.D2.

> **Superseded:** 13D2 below was later executed and closed PASS for the defined actual
> Obsidian write-concurrency acceptance. It does not establish native FSA atomic-write
> safety; that question is separately closed NO-GO by 13.3.

### 13.1P / 17.2A Independent Proxima writer coexistence

- [x] Two independently constructed coordinators sharing one disposable disk vault
      refuse symmetric stale same-source updates; the winner's bytes remain exact.
- [x] Independent delete/move/destination conflicts return missing/stale or
      destination-exists without last-writer-wins behavior.
- [x] Independent sources commit concurrently and durable recovery records remain
      attributable to the correct writer/request ID.
- [x] No coordinator queue is shared across writer instances; no UI/native capability
      is required.
- [ ] Native creator-vault/FSA authority and actual Obsidian application remain open.

### 13.1P-F Non-mutating conflict finalization

- [x] Structured stale/destination conflicts terminalize their prepared recovery
      record as `recovered` (no-op complete), so normal races cannot poison restart.
- [x] Restart after a stale loser reports mutation authority available while the
      winner remains durably committed.
- [x] Terminal-status persistence failure is fail-visible as `recovery-required`;
      thrown/ambiguous writer failures are not falsely marked recovered.

Not enabled merely because a UI needs editing.

### 13.1 Conflict model

- [x] observed source revision
- [x] intended logical mutation
- [x] serialize preserving unknown data
- [x] checked commit
- [x] stale result
- [x] retry/merge/refuse policy
- [x] rename conflict behavior
- [x] deletion conflict behavior
- [ ] external Obsidian edit during Proxima edit — native Obsidian 13D2 remains OPEN

> **Superseded:** the external-Obsidian-edit case is closed by 13D2 below. This
> unchecked row is preserved as the state of the conflict-model checklist before that
> native application acceptance ran.
- [x] two Proxima surfaces editing same source
- [x] process-death/restart recovery behavior where relevant; fsync/power-loss
      durability is explicitly not claimed

### 13.1R Repo-only conflict-model closeout

- [x] SourceRef revisions flow through semantic scalar/optional/promotion/lifecycle
      APIs into conditional coordinator operations.
- [x] Typed task operations express intended logical mutations; no renderer or
      arbitrary filesystem intent is accepted.
- [x] Source-span patching preserves unknown/unsupported bytes exactly; no lossy
      interpreted frontmatter projection is serialized.
- [x] Coordinator conditional update/move/delete and exclusive create provide the
      checked commit boundary.
- [x] Deterministic peer races return stale/missing/destination-exists and preserve
      peer bytes; policy is refusal with no retry, merge or last-writer-wins.
- [x] Rename/delete conflict behavior, independent Proxima surfaces, and durable
      request attribution are covered by 13.1P/17.2A and 13.2E evidence.
- [x] Process death before/after filesystem commit and restart classification are
      covered by 13C2B/C3F durable journal tests; this row does not claim power-loss
      or fsync guarantees.
- [ ] Actual Obsidian application edits during Proxima writes remain OPEN at 13D2;
      disposable peer-writer evidence is not substituted.

> **Superseded by 13D2:** actual Obsidian edits during Proxima's conditional-write
> window were later exercised; Proxima returned `stale` and preserved the Obsidian
> bytes. This historical OPEN row remains unchanged.

### 13.2 Writer conformance

Fixture only initially.

- [x] update ordinary task (`tests/taskSourceMutation.test.ts`)
- [x] preserve body (`tests/taskSourceMutation.test.ts`)
- [x] preserve unknown frontmatter (`tests/taskSourceMutation.test.ts`)
- [x] preserve unsupported YAML/source text (`tests/taskSourceMutation.test.ts`)
- [x] stale revision refuses (`tests/taskSourceMutation.test.ts`)
- [x] concurrent external change refuses (`tests/taskSourceMutation.test.ts`)
- [x] no accidental field reformatting beyond agreed scope (`tests/taskSourceMutation.test.ts`)
- [ ] Obsidian reopens resulting file normally
- [ ] Excalidraw/plugin-specific sections preserved exactly where required

### 13.2B Existing task scalar mutation surface

#### Shared source patch engine

- [x] Existing unique top-level scalar patching is field-generic internally.
- [x] The application boundary accepts only a closed allowlist of task fields;
      arbitrary frontmatter field names are not a write primitive.
- [x] No interpreted frontmatter object is serialized; every non-target source byte
      remains exact and missing-key insertion remains deferred.
- [x] Duplicate, nested, structured and malformed targets refuse; supported string
      quote style, comments and surrounding whitespace remain unchanged.

#### Typed field semantics

- [x] `name`, `project`/legacy `projectId` and `status` accept bounded non-control
      strings; the source's project alias is preserved rather than renamed.
- [x] `weight`, `orderIndex`, `fixedDuration` and `maxDuration` enforce the same
      finite/positive ranges as reader validation.
- [x] `isFixedDuration` and `isCompleted` emit real YAML booleans; dates use the
      reader's valid date semantics; `createdAt`, null/removal and insertion remain
      outside this slice.
- [x] Numeric/boolean writes use canonical unquoted scalars while string writes
      retain existing quote style; comments, spacing and foreign YAML remain exact.

#### CAS / recovery and cross-check

- [x] Every field update travels through `createVaultMutationCoordinator`, uses the
      observed revision, commits durable recovery, and terminalizes stale no-ops as
      `recovered`; no retry or merge occurs.
- [x] Mutated files reload through `loadVaultState` with intended values while
      unrelated task fields remain unchanged (`tests/taskSourceMutation.test.ts`).

### 13.2B-F Typed scalar authority correction

- [x] Runtime field membership is enforced before source acquisition; unknown fields
      return `field-not-allowed` with zero reader/coordinator/writer calls.
- [x] `UpdateTaskScalarOptions` is a discriminated union, and the public semantic
      surface exposes one `project` field rather than a subordinate `projectId`
      mutation authority.
- [x] Project writes select the existing preferred `project:` or sole legacy
      `projectId:` spelling and refuse when both aliases are present.
- [x] Plain string replacements are accepted only when the existing reader's scalar
      interpretation remains the exact same string; plain `true`, `false`, `null`,
      `~` and numeric-like values refuse, while quoted equivalents remain writable.
- [x] Runtime authority, alias ambiguity, scalar round-trip and zero-read regressions
      are covered in `tests/taskSourceMutation.test.ts`.

### 13.2B-F2 No implicit removal through scalar update

- [x] Empty `name` and `project` values are rejected before source acquisition,
      including when the existing source uses quoted style.
- [x] Empty scalar attempts perform zero coordinator/writer calls; explicit unlink,
      null and removal semantics remain deferred to 13.2C.

### 13.2C Explicit optional-field set / clear

#### Authority and existing fields

- [x] Public set/clear operations expose only `project`, `fixedDuration`,
      `maxDuration`, `startDate` and `deadline`; runtime kind/field membership is
      enforced before source acquisition.
- [x] Existing set uses the signed 13.2B source-preserving replacement behavior;
      project aliases are selected semantically and ambiguity refuses.
- [x] Every filesystem change still travels through
      `createVaultMutationCoordinator`; no arbitrary insertion/removal primitive is
      exposed.

#### Insertion and explicit clear

- [x] Missing optional fields insert immediately before the closing fence, preserving
      BOM, detected LF/CRLF convention, key order and all foreign/unsupported bytes.
- [x] Explicit clear removes only the target line (including its inline comment),
      preserves surrounding comments and foreign bytes, and refuses duplicates or
      structured targets.
- [x] Clearing an absent field is a deterministic no-op; no frontmatter creation,
      null sentinel or empty-string removal is inferred.

#### Semantic validation and coexistence

- [x] Set values use the existing reader's non-empty string, positive-duration and
      valid-date semantics; resulting files reload through `loadVaultState` (where
      applicable) to the intended optional value.
- [x] Caller revisions bind insertion and clear to CAS/recovery; stale edits preserve
      peer bytes and terminalize no-op recovery without retry or merge.
- [x] CRLF/BOM insertion, line-only clear, missing-field no-op, invalid/unsupported
      targets and stale optional commits are covered by
      `tests/taskSourceMutation.test.ts`.

### 13.2D Canonical task creation

#### Authority and identity

- [x] Only semantic task creation is exposed; runtime input validation precedes any
      coordinator call, and no Date.now/random identity is generated inside it.
- [x] Explicit path-safe task id is required; destination is deterministically
      `<tasksDirectory>/<id>.md` with the preferred default `Proxima/tasks`.

#### Canonical source and bounds

- [x] New bytes come from a fixed LF canonical task template, never a generic YAML
      object serializer; id/name/createdAt are required and reader-valid.
- [x] Preferred `project:` spelling is used for new files; optional fields are emitted
      only when supplied; numeric/boolean/date/string semantics match the reader.
- [x] Generated bytes and body are bounded; unsafe strings are quoted so reloads retain
      exact values; arbitrary input keys cannot inject YAML.

#### Exclusive create and read-back

- [x] Creation travels only through coordinator `create` → `createIfAbsent`; existing
      destinations remain byte-exact and concurrent creators yield one winner without
      overwrite, retry or fallback filename.
- [x] Created files reload through `loadVaultState` with explicit id/source provenance,
      supplied fields, documented defaults for omitted fields and intact Markdown body.
- [x] Invalid ids/dates/numbers/booleans, unsafe paths and over-limit bodies refuse
      before writer calls (`tests/taskCreation.test.ts`).

### 13.2E Semantic task rename/delete

#### Authority and target identity

- [x] Rename/delete accept observed task source provenance, verify `source.kind` at
      runtime, and reject malformed provenance before coordinator calls.
- [x] Rename requires explicit frontmatter identity; filename-derived legacy tasks are
      refused rather than implicitly changing logical IDs. Delete supports either.
- [x] No arbitrary generic filesystem move/delete path is exposed.

#### Rename and identity

- [x] Rename accepts only a bounded safe filename stem and deterministically derives a
      same-directory `<stem>.md` destination; traversal, absolute and nested names
      refuse.
- [x] Rename travels through coordinator `move`, moves bytes byte-exactly, preserves
      frontmatter/body/fields and explicit logical ID, and never overwrites or chooses
      a fallback filename.
- [x] Destination collisions preserve existing bytes; `loadVaultState` reports the
      renamed task's updated source provenance.

#### Delete and coexistence

- [x] Delete travels through coordinator `delete`, removes only the selected task,
      leaves unrelated files intact and performs no cascade/recreation.
- [x] Stale peer edits and destination races refuse without overwriting peer bytes;
      independent coordinators produce at most one rename/delete winner and durable
      recovery attribution remains isolated (`tests/taskSourceLifecycle.test.ts`).

### 13.2E-F Task-source authority and independent rename race

- [x] Lifecycle operations are bound to the configured task directory and require an
      immediate Markdown child; fabricated outside paths, nested paths and
      `idOrigin: folder` refuse before coordinator calls.
- [x] Portable reserved stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`LPT9`) are refused
      by device basename even with dotted suffixes, alongside traversal/absolute names;
      ordinary dotted stems remain valid.
- [x] Two independent coordinators racing the same observed rename yield one winner;
      the old source is not recreated, the winner bytes remain exact, and each
      recovery store remains attributable (loser is missing/stale or recovered no-op).

### 13.2F Legacy task identity promotion

#### Authority and identity consistency

- [x] Promotion accepts only observed immediate task-child provenance with
      `source.kind: task` and `idOrigin: filename`; explicit-id tasks return an
      explicit no-op before reads, while folder/project/event/fabricated/nested
      provenance refuses.
- [x] No replacement ID is accepted: the supplied task id must equal the current
      filename stem, otherwise promotion refuses before coordinator execution.

#### Source preservation and CAS

- [x] Existing frontmatter is required; a missing `id:` is inserted immediately before
      the closing fence with preserved BOM/LF/CRLF convention and reader-safe quoting.
- [x] Existing frontmatter/body, foreign/unsupported YAML and all non-target bytes stay
      exact; malformed or duplicate `id:` refuses rather than replacing guessed spans.
- [x] Promotion uses observed revision through coordinator update, leaves durable
      committed recovery on success, refuses stale peer edits without overwrite, and
      leaves stale no-op recovery terminalized.

#### Read-back / lifecycle

- [x] Fresh `loadVaultState` changes only source identity origin to `frontmatter`, keeps
      the same logical ID/path/fields/body, and the promoted task subsequently passes
      the explicit-ID rename boundary (`tests/taskIdentityPromotion.test.ts`).

### 13.2F-F Bounded observed provenance

- [x] Promotion bounds nonempty task ID (≤200), source path (≤260) and revision
      (≤400) before any binary read, on both mutation and explicit no-op paths.
- [x] Oversized IDs/paths/revisions and empty revisions refuse with zero readBinary or
      coordinator calls; immediate-child, task-kind and filename-origin checks remain
      enforced (`tests/taskIdentityPromotion.test.ts`).

### 13.2A Source-preserving task status mutation

- [x] D7 is explicitly re-decided for write-era source patching; the interpreted
      frontmatter projection is never serialized.
- [x] Exact bounded UTF-8 source bytes are acquired through `readBinary`; source
      size and invalid UTF-8 fail closed.
- [x] Only one existing, unique, top-level scalar `status:` span is writable; missing,
      duplicate, nested, structured, malformed and unsafe targets refuse visibly.
- [x] Plain, single-quoted and double-quoted status representations preserve their
      style, surrounding whitespace, inline comments, BOM and LF/CRLF bytes.
- [x] Unknown keys, nested mappings, block scalars, anchors/aliases and Markdown body
      bytes remain exact even when the reader's interpretation is lossy.
- [x] The patch is submitted through `createVaultMutationCoordinator` with the
      caller's observed revision; stale edits preserve peer bytes and terminalize the
      no-op recovery record as `recovered`.
- [x] Focused adversarial fixtures cover ordinary success, exact preservation,
      unsupported targets, invalid UTF-8, unsafe values and stale external edits
      (`src/app/sourcePreservingMarkdown.ts`, `src/app/taskSourceMutation.ts`,
      `tests/taskSourceMutation.test.ts`).

### 13.2G Source-preserving project scalar mutation

#### Authority and provenance

- [x] Project scalar writes expose a closed discriminated union for `name`, `status`,
      `projectType`, `tabBgColor` and `tabTextColor`; runtime membership rejects
      unknown fields before any source read or coordinator call.
- [x] Observed provenance must be `source.kind: project`, bounded and normalized,
      and confined to the configured projects directory. Flat `<id>.md` sources and
      one-level `<folder>/index.md` sources are accepted; deeper, fabricated,
      outside-root and mismatched caller paths refuse before I/O.

#### Semantics and exact preservation

- [x] Names are non-empty bounded strings; status is `active|archived`; project type
      is `task|schedule`; tab colors are bounded non-control strings. Empty or
      malformed values refuse without a write.
- [x] Only the unique top-level scalar target is patched. BOM, LF/CRLF convention,
      quote style, spacing, comments, linked folders, unsupported YAML, anchors,
      block-scalar/body bytes and every non-target byte remain exact; parsed project
      state is never serialized back to Markdown.

#### CAS, recovery and read-back

- [x] Updates use the observed revision through `createVaultMutationCoordinator`,
      preserve peer bytes on stale edits, and retain durable recovery attribution;
      no retry, merge or fallback destination is used.
- [x] Coordinator CAS is derived directly from `project.source.revision`; no
      independent caller-selected expected revision can upgrade stale state.
- [x] The focused binding regression verifies the observed revision is passed to
      the coordinator (`tests/projectSourceMutation.test.ts`).
- [x] Flat and folder/index writes reload through `loadVaultState` with unchanged
      project identity/source provenance and only the intended scalar changed;
      adversarial provenance, validation, preservation and stale-race cases are
      covered by `tests/projectSourceMutation.test.ts`.

### 13.2H Explicit project optional metadata set / clear

- [x] Public operations expose only explicit `{ kind: 'set'|'clear', field:
      'tabBgColor'|'tabTextColor' }`; runtime authority rejects unknown kinds/fields
      before source acquisition, and empty strings are not clear sentinels.
- [x] The signed 13.2G project provenance boundary is reused for flat and one-level
      folder/index sources; outside, deep and non-project paths refuse before read,
      while CAS derives only from `project.source.revision`.
- [x] Set replaces an existing target with the signed scalar rules or inserts a
      missing target immediately before the closing fence using bounded, reader-safe
      encoding and preserved BOM/LF/CRLF convention.
- [x] Clear removes exactly one existing target line and its inline comment; clearing
      an absent field is a deterministic no-op, while duplicate/structured/malformed
      targets refuse.
- [x] Unrelated metadata, description/body, linked-folder encodings, foreign YAML,
      identity and source provenance remain exact; no parsed Project is serialized.
- [x] Effective set/clear uses coordinator update with durable recovery and stale
      peer refusal; focused flat/folder insert-clear, reload, preservation and stale
      regressions pass in `tests/projectOptionalMutation.test.ts`.

### 13.2I Project description override / body fallback

- [x] Public authority is limited to explicit `{ kind: 'set', value }` and
      `{ kind: 'use-body' }`; runtime kind validation rejects arbitrary fields and
      empty/null sentinels before source reads.
- [x] Signed 13.2G/H provenance and observed-revision CAS rules are reused for flat
      and one-level folder/index projects; outside/deep/non-project sources refuse.
- [x] Set patches an existing supported scalar or inserts a missing description
      immediately before the fence with bounded reader-safe encoding; quote style,
      comments and spacing are preserved on replacement.
- [x] `use-body` removes exactly one supported description line (including its
      comment), leaves Markdown body untouched, and is a deterministic no-op when
      no override exists; the reader then exposes its existing body fallback.
- [x] Duplicate, nested, malformed and block-scalar description targets refuse;
      foreign YAML, BOM/LF/CRLF, linked-folder metadata, identity and all unrelated
      bytes remain exact, with no parsed Project serialization.
- [x] Effective set/use-body operations use coordinator update and durable recovery;
      stale peer bytes survive. Flat/folder reload, fallback transition, malformed
      refusal and zero-read authority tests pass in `tests/projectDescriptionMutation.test.ts`.

### 13.2J Legacy project identity promotion

- [x] Promotion accepts only bounded `source.kind: project` provenance confined to
      the configured projects directory; flat filename and one-level folder/index
      origins are supported, while frontmatter origin is an explicit no-op before
      reads and outside/deep/arbitrary paths refuse.
- [x] The derived identity is exact filename stem or containing folder name; the
      caller cannot supply a replacement ID, and mismatches refuse before I/O.
- [x] Existing frontmatter is required and one reader-safe `id:` is inserted before
      the closing fence, preserving BOM/line endings, description, linked folders,
      body and every prior source byte; malformed/duplicate/structured IDs refuse.
- [x] Promotion uses coordinator update with CAS derived solely from the observed
      project revision, durable recovery and stale-peer preservation; no retry,
      merge, move or generic YAML insertion is exposed.
- [x] Flat and folder/index reloads retain the same logical ID/path and all semantic
      project fields while changing only identity origin to frontmatter. Focused
      promotion, no-op, mismatch, malformed, duplicate and stale tests pass in
      `tests/projectIdentityPromotion.test.ts`.

### 13.2K Existing event scalar mutation

- [x] Closed runtime-checked event authority exposes only `name`, `project`,
      `startDate`, `deadline` and `isCompleted`; createdAt, description, insertion,
      identity and lifecycle remain outside this slice.
- [x] Event provenance is bounded, confined to immediate Markdown children of the
      configured events directory, and rejects project/task/nested/outside sources
      before reads; CAS derives solely from `event.source.revision`.
- [x] Values use reader-compatible semantics: nonempty bounded name/project,
      validated dates and real YAML booleans. Project writes preserve the preferred
      or sole legacy alias and refuse when both aliases are present.
- [x] Only one existing unique top-level target is source-patched; missing,
      nested, structured, malformed and unsafe targets refuse. Quote style,
      whitespace, comments, BOM/CRLF, Markdown body and foreign YAML stay exact;
      no parsed CalendarEvent is serialized.
- [x] Updates use coordinator CAS/recovery with stale-peer preservation and no
      retry/merge/LWW. Focused all-field reload, alias ambiguity, authority,
      preservation and stale tests pass in `tests/eventSourceMutation.test.ts`.

### 13.2L Explicit event optional mutation

- [x] Runtime accepts only six named semantic operations: set/unlink project,
      set/clear start, and set/use-start-as-deadline; null/empty values and generic
      event key insertion/removal are not authorities.
- [x] Signed immediate-event provenance and observed-revision CAS rules are reused;
      outside, nested and non-event sources refuse before reads.
- [x] Project set/unlink preserves the preferred/legacy alias rule, inserts preferred
      `project:` when absent, removes only the active alias, and makes missing unlink
      a deterministic no-op with `projectId === null` on reload.
- [x] Start set/clear and deadline set/use-start-as-deadline patch or insert/remove
      only their named lines with reader-valid dates. Start clearing leaves deadline
      bytes untouched; removing deadline exposes the reader's start fallback.
- [x] Duplicate, structured, malformed and unsafe targets refuse; BOM/line endings,
      body, foreign YAML and unrelated event fields remain exact, with no parsed
      CalendarEvent serialization.
- [x] Effective operations use coordinator update/recovery with stale-peer
      preservation and no retry/merge/LWW. Focused six-operation, insertion,
      fallback, no-op, authority and preservation tests pass in
      `tests/eventOptionalMutation.test.ts`.

### 13.2M Legacy event identity promotion

- [x] Promotion accepts only bounded immediate `source.kind: event` provenance in
      the configured events directory; filename-origin events are promotable,
      frontmatter-origin events no-op before reads, and other origins/paths refuse.
- [x] The exact filename stem is the only accepted logical ID; callers cannot
      replace or normalize it, and mismatches refuse before source access.
- [x] Existing frontmatter is required; one reader-safe `id:` is inserted before
      the closing fence while preserving BOM/line endings, project aliases, dates,
      completion, body and every non-target byte. Malformed/duplicate/structured
      targets refuse.
- [x] Promotion uses coordinator update with CAS from `event.source.revision`,
      durable recovery and stale-peer preservation; no move, retry, merge or generic
      YAML insertion is exposed.
- [x] Reload preserves logical ID/path and all event semantics while changing only
      identity origin to frontmatter. Focused `01.md`/`null.md`, no-op, mismatch,
      malformed, duplicate and stale tests pass in `tests/eventIdentityPromotion.test.ts`.

### 13.2N Event description override / body fallback

- [x] Public event authority is explicit `set` versus `use-body`; runtime rejects
      other kinds and empty/null sentinels before source reads.
- [x] Signed immediate-event provenance and observed-revision CAS rules are reused
      for flat event files; outside, nested and non-event sources refuse.
- [x] Set patches an existing supported scalar or inserts a missing description with
      bounded reader-safe encoding; replacement quote style, spacing and comments
      remain exact and reload yields the requested description.
- [x] `use-body` removes only one supported scalar override, leaves Markdown body
      untouched, and deterministically exposes the reader's existing body fallback;
      absent override is a no-op.
- [x] Duplicate, nested, malformed and block-scalar descriptions refuse. ID,
      project aliases, dates, completion, foreign YAML, BOM/line endings and all
      unrelated bytes remain exact; no parsed CalendarEvent is serialized.
- [x] Effective operations use coordinator update/recovery with stale-peer
      preservation and no retry/merge/LWW. Focused set/use-body, insertion, fallback,
      malformed and zero-read tests pass in `tests/eventDescriptionMutation.test.ts`.

### 13.2O Task description override / body fallback

- [x] Public task authority is explicit `set` versus `use-body`; runtime rejects
      other kinds and empty/null sentinels before reads, with no generic task-field
      mutation exposed.
- [x] Signed task provenance is enforced: bounded ID/path/revision, immediate task
      Markdown child, task-only source kind, and observed-revision-only CAS.
- [x] Set patches an existing supported description scalar or inserts a missing one
      with bounded reader-safe encoding; replacement style/spacing/comments remain
      exact and reload returns the requested description.
- [x] `use-body` removes only the supported description override, leaves Markdown
      body untouched, and deterministically exposes the reader's existing fallback;
      absent override is a no-op.
- [x] Duplicate, nested, malformed and block-scalar targets refuse. ID/name/project
      aliases/status/durations/dates/completion, foreign YAML, BOM/line endings and
      all unrelated bytes remain exact; no parsed Task is serialized.
- [x] Effective updates use coordinator recovery with stale-peer preservation and
      no retry/merge/LWW. Focused set/use-body, insertion, fallback, block refusal
      and zero-read provenance tests pass in `tests/taskDescriptionMutation.test.ts`.

### 13.2P Canonical event creation

- [x] Creation exposes only typed event input and derives the flat destination
      `<eventsDirectory>/<id>.md` internally; relative bounded directories, safe IDs
      and portable device-stem rejection prevent arbitrary paths.
- [x] Required name/createdAt and optional project/start/deadline/completion values
      use reader-compatible bounded semantics; invalid input and oversized bodies
      refuse before coordinator calls.
- [x] Canonical LF UTF-8 source emits explicit id/name/createdAt, preferred
      `project:`, only supplied optionals, safe quoting and bounded body bytes.
- [x] New files reload with frontmatter identity, supplied semantics, undated-start
      and missing-deadline fallback behavior intact; no identity generation or
      lifecycle operation is bundled.
- [x] Creation uses coordinator `create` and exclusive `createIfAbsent`; existing
      bytes are never overwritten, concurrent creators have one winner, and no
      retry/alternate filename/merge/LWW occurs. Focused canonical, quoting,
      validation and collision tests pass in `tests/eventCreation.test.ts`.

### 13.2Q Canonical project creation

- [x] Creation exposes only typed project input and derives a flat
      `<projectsDirectory>/<id>.md` destination internally; no folder/index or
      caller-selected path is accepted. IDs/directories are bounded, safe and
      reject traversal, drives and portable device stems.
- [x] Required name/createdAt and optional status/projectType/colors/description/body
      use reader-compatible bounded semantics; linked-folder fields are not accepted
      and invalid/oversized input refuses before coordinator calls.
- [x] Canonical LF UTF-8 source emits explicit identity/name/createdAt, preferred
      spellings, only supplied optionals, safe quoting and bounded final bytes;
      parsed Project projection is never serialized.
- [x] Flat reload yields frontmatter identity, supplied metadata, archived presence,
      explicit-description precedence or Markdown-body fallback, and unchanged
      source provenance.
- [x] Creation uses coordinator `create` with exclusive `createIfAbsent`; existing
      bytes and concurrent winners are preserved, losers receive deterministic
      conflicts, and no alternate filename/retry/merge/LWW occurs. Focused canonical,
      quoting, fallback, validation and collision tests pass in
      `tests/projectCreation.test.ts`.

### 13.2R Preferred project linkedFolders set / clear

- [x] Public authority is limited to explicit set/clear over preferred
      `linkedFolders`; no generic list/frontmatter API or project lifecycle is exposed.
- [x] Signed project provenance/CAS boundaries are reused for flat and one-level
      folder/index sources; bounded folder paths/names, count and encoded size are
      enforced before reads, with duplicate semantic paths refused.
- [x] Missing set inserts preferred inline-list `linkedFolders`; an existing unique
      preferred inline list is replaced; clear removes exactly that line and missing
      clear is a deterministic no-op.
- [x] Singular `linkedFolder`, packed-string legacy `linkedFolders`, mixed/duplicate,
      block, nested and malformed forms refuse without migration or canonicalization.
- [x] Canonical entries encode leaf paths or reader-compatible `Name|path` strings;
      reload returns requested ordered folder semantics without relying on dedupe.
- [x] Only target bytes change; identity/name/status/type/colors/description/body,
      foreign YAML, comments, BOM and line endings remain exact. Coordinator update,
      recovery and stale-peer rules apply; focused flat/folder, preservation,
      invalid-input and stale tests pass in `tests/projectLinkedFoldersMutation.test.ts`.

### 13.2S Legacy project linked-folder promotion

- [x] Promotion accepts no replacement folder list; it derives existing reader
      semantics only from one unambiguous legacy source. Preferred inline lists and
      absent sources return explicit no-ops, while project provenance reuses the
      bounded flat/folder boundary and observed-revision CAS.
- [x] Unique singular `linkedFolder:` and packed scalar `linkedFolders:` entries
      promote to preferred inline `linkedFolders: [...]`, retaining ordered names
      and paths with safe YAML encoding.
- [x] Mixed/singular-plus-preferred, duplicate keys or semantic paths, empty/invalid
      packed entries, list/block/nested/malformed targets and unsupported comments
      refuse rather than dropping data or migrating heuristically.
- [x] Only the legacy target representation changes; unrelated frontmatter,
      description/body, foreign YAML, BOM and line endings remain exact. Resulting
      projects reload identically and are subsequently writable through 13.2R.
- [x] Promotion uses coordinator update/recovery with stale-peer preservation and no
      retry/merge/LWW. Focused singular/packed, no-op, malformed, duplicate and
      stale tests pass in `tests/projectLinkedFoldersPromotion.test.ts`.

### 13.2 Semantic writer surface closeout

- [x] Task, project and event canonical creation mappings are recorded by 13.2D,
      13.2P and 13.2Q; existing scalar, optional, description and identity paths
      are mapped across all three kinds by 13.2B–O.
- [x] Preferred project linkedFolders mutation and explicit lossless legacy
      promotion are mapped by 13.2R–S; no arbitrary frontmatter/YAML writer exists
      or is implied.
- [x] Task lifecycle remains carried from its signed 13.2E gate; project and event
      lifecycle remain explicitly OPEN. `createdAt` mutation is not exposed and
      requires a separate product decision and gate.
- [x] Native FSA/check-to-commit atomicity and actual Obsidian coexistence remain
      OPEN at Gate 13.3/13D2; disposable peer evidence is not substituted.
- [x] Commits after 83692ff are local-only supplied evidence while GitHub connectivity
      is unavailable; no connector verification is claimed for those SHAs.

> **Superseded immediately below:** 13.2T implements repo-only project and event
> rename/delete lifecycle, and 13D2 closes actual Obsidian write concurrency while 13.3
> closes the native FSA atomicity question as NO-GO. `createdAt` mutation remains
> outside the exposed mutation surface, and neither later result enables creator-vault
> writes. The rows above are preserved as the state recorded at this checkpoint.

### 13.2T Project and event lifecycle (repo-only)

- [x] Project lifecycle accepts observed provenance in flat and one-level
      folder/index layouts; explicit-ID rename preserves logical identity, while
      delete supports legacy or explicit identity without cascade.
- [x] Event lifecycle accepts immediate Markdown sources; explicit-ID rename
      preserves identity and delete removes only the observed source.
- [x] Destination stems are bounded/portable; traversal and device names refuse,
      folder/index renames derive sibling `<stem>/index.md`, and no arbitrary path
      or fallback filename is exposed.
- [x] Rename/delete use coordinator move/delete with observed-revision CAS, stale
      peer preservation and collision/recovery attribution; no retry/merge/LWW.
- [x] Focused project/event lifecycle coverage passes in
      `tests/recordLifecycle.test.ts`; native FSA write authority is resolved by
      the explicit 13.3 safety boundary below.

### 13D2 Actual Obsidian-vs-Proxima write concurrency

- [x] The registered real Obsidian application performs create, modify and delete
      through `app.vault`; Proxima observes each transition with zero writes and
      restores the plugin/configuration byte-for-byte.
- [x] During the exact conditional-write window, Obsidian modifies the observed
      probe through `app.vault.modify`; the built Proxima coordinator returns
      `stale`, does not commit its bytes, and the Obsidian bytes remain exact.
- [x] The bounded harness reports `obsidian:write-race: PASS`, `bytesPreserved: true`,
      `proximaStatus: stale`, and `proximaWrites: 0` before the normal delete and
      cleanup stages. This closes the actual Obsidian write-concurrency claim; it
      does not claim Papers-hosted FSA access or atomic native writes.
- [x] Evidence command: `npm run agent:coexist -- --root <registered-vault>
      --obsidian <Obsidian.exe>` (run against the registered legacy-layout vault;
      all stages PASS, including `obsidian:write-race`).

### 13.3 Decide whether FSA writes are safe enough

- [x] expected-revision checking is classified as **non-atomic** for native FSA:
      `FileSystemFileHandle.createWritable()` provides no compare-and-swap or
      conditional-replace primitive.
- [x] The residual check-to-replace race is **unacceptable** for shared creator
      files; the peer race is proven by 13D2 and cannot be eliminated by a second
      JavaScript read.
- [x] Native/FSA writes remain disabled, so an Obsidian external write cannot be
      silently overwritten by Proxima. `evaluateFsaWriteBoundary()` emits the
      bounded `BLOCKED / fsa-no-compare-and-swap` report and has focused tests in
      `tests/fsaWriteBoundary.test.ts`.
- [x] Gate 13.3 is therefore **CLOSED / NO-GO** for the current native capability:
      read-only FSA is supported; enabling writes requires a future Papers/native
      compare-and-swap transaction primitive and a new acceptance gate.

If not, specific missing truth:

> "A Backpack that edits shared files cannot atomically commit only when the file still
> matches the revision it previously read."

---

## Gate 14 — Durable autonomous owner authority

After one owner enrollment, the agent must regain the exact granted vault authority
and operate through Papers across restarts without human UI intervention.

- [x] Owner authority is explicit and scoped to one exact vault/root when supplied;
      the bridge rejects omitted roots and the browser boundary never discovers one.
- [x] Initial enrollment requirements are documented separately from normal operation
      (`evaluateOwnerAuthorityBoundary()` and `docs/DECISIONS.md` D51–D52).
- [x] No per-operation confirmation or repeat picker is part of normal read-only
      startup; prompt/denied permission remains a machine-readable blocked state.
- [x] Read authority restores programmatically after restart; write authority remains
      disabled because Gate 13.3 proved native FSA commits non-atomic.
- [x] Revoked/prompt authority becomes a machine-readable blocked state through the
      existing handle-bootstrap inspection and preflight reports.
- [x] Persisted browser FSA restoration is tested; when native grant/transaction
      capability is absent, the smallest scoped capability is read-only inspection.

### 14.1 Native acceptance is agent-driven

- [x] Agent launches the bounded bridge acceptance and observes authority state.
- [x] Agent issues programmatic read operations and retrieves bounded evidence;
      write operations are refused by the owner boundary.
- [x] Agent starts the independent peer/actual Obsidian acceptance where required
      (13D1/13D2) and verifies stale preservation.
- [x] Agent verifies exact build identity and tears down disposable resources.

**Gate 14 outcome: CLOSED / READ-ONLY BOUNDARY.**
`evaluateOwnerAuthorityBoundary()` emits `BLOCKED` with
`native-fsa-grant-and-transaction-required`; enabling creator-vault writes is not
claimed and requires a future native transaction capability plus explicit enrollment.

Separate approval gate for creator data. Do not jump directly to Excalidraw writing.

Separate approval gate.

- [ ] Previous write-model gate signed off.
- [ ] Explicit creator decision to allow writes.
- [ ] Mutation UI clearly distinguishes live creator data from fixture mode.
- [ ] Agent writes to real vault remain disabled by default.
- [ ] One smallest record type enabled first.
- [ ] Obsidian round-trip tested.
- [ ] External-concurrent-edit test passes.
- [ ] Stale write visibly refused.
- [ ] Evidence proves no unrelated bytes changed.
- [ ] Rollback/recovery story exists.

Do not jump directly to Excalidraw writing.

---

## Gate 15 — Excalidraw editing, optional

### 15.1 Core scene round-trip

- [ ] Parse representative raw scene.
- [ ] Edit using upstream Excalidraw.
- [ ] Serialize.
- [ ] Reopen in upstream Excalidraw.
- [ ] Reopen in Obsidian Excalidraw where applicable.
- [ ] Images/files survive.
- [ ] IDs survive.
- [ ] No plugin-specific Markdown lost.

### 15.2 `.excalidraw.md`

- [ ] Parse current plugin format.
- [ ] Preserve unrelated Markdown/frontmatter.
- [ ] Preserve plugin sections not owned by Proxima.
- [ ] Compression mode handled.
- [ ] Unsupported plugin constructs fail visibly.
- [ ] Internal Obsidian links behavior explicitly scoped.
- [ ] Embedded Markdown behavior explicitly scoped.
- [ ] Transclusions explicitly scoped.
- [ ] Scripts/plugin integrations explicitly out of scope unless later approved.

### 15.3 Licensing

- [ ] Upstream Excalidraw MIT usage reviewed.
- [ ] Obsidian Excalidraw AGPL code is not copied unintentionally.
- [ ] Format-compatibility implementation is independently written or licensing decision
      is explicit.

---

## Gate 16 — Optional native thumbnails / richer file previews

Only after fallback file cards are already first-class.

### 16.1 Need

- [ ] Show actual unsupported formats whose experience materially benefits from native
      thumbnails.

### 16.2 Smallest capability if needed

- [ ] request thumbnail for already authorized file reference
- [ ] bounded dimensions
- [ ] bounded bytes
- [ ] unavailable result allowed
- [ ] no arbitrary path lookup
- [ ] no Proxima semantics inside Papers

### 16.3 Larger media

- [ ] establish exact renderer need
- [ ] decide bundled renderer vs browser native
- [ ] only then consider resource URL/range/stream capability
- [ ] never broaden the project asset scheme to unrestricted machine paths

---

## Gate 17 — Cross-surface behavior

### 17.1 Multiple live Proxima surfaces

- [x] same fixture in two independent source sessions/surfaces.
- [x] same disposable real-disk vault is opened by two independent sessions.
- [x] refresh in one and then the other converges both projections to the same
      source generation and bytes (`tests/multiSurface.test.ts`).
- [x] navigation/selection independence is specified and pinned: each dispatcher
      retains its own selection while consuming the shared source snapshot.
- [x] source revision model is consistent across both sessions; each advances from
      generation 1 to 2 for the same external change.
- [x] no surface-local state is written as canonical file state; the multi-surface
      tests use read-only sessions and dispose both refresh policies.
- [x] scoped ordering does not cross-contaminate surfaces — asserted with three tasks whose
      three orders are three different permutations: the project Task Board and the Backlog both
      follow the execution scope and agree with each other, the workflow board follows the
      workflow scope, the Gantt follows chronology (neither durable scope), and a change to one
      durable scope leaves the other scope's **stored** values and the other surfaces' renderings
      untouched. The third order-ish fact is not a scope at all: placing a Gantt row is local
      state, and the case asserts every record file and revision is byte-identical afterwards
      (`tests/scopedOrdering.test.ts`, `docs/DECISIONS.md#d64`).

### 17.2 If writes become enabled

- [ ] simultaneous Proxima edits tested
- [x] stale writer refused — the store refuses a conditional write whose observed revision has
      moved, and the two Proxima callers that exist are asserted against each other over one
      record in **both** directions: the agent writes first and the UI drops from the projection
      it rendered before, then the UI writes first and the agent submits the revision it read
      before. Whichever loses is refused `stale-revision` **with the revision that beat it**,
      re-reads rather than merging, and the record keeps the winner's value
      (`tests/agentWritePath.test.ts`, `tests/recordMutationConcurrency.test.ts`).
- [ ] unrelated-file edits preserved
- [x] same-file conflict explicit — the refusal is typed, names the revision that won, and the
      loser's projection still holds what it held, so nothing was merged into it; the store-level
      contract is Gate 13's conditional writer and the two-caller case above is the surface level
      (`tests/agentWritePath.test.ts`, `tests/recordMutationConcurrency.test.ts`).
- [ ] last-writer-wins used only where intentionally specified

---

## Gate 18 — Performance and scale

- [x] 100 records — deterministic headless baseline covers 100 projects, 100 tasks
      and 100 events (300 total; Gate 18A, `0d01ba3`).
- [x] 1,000 records — deterministic headless baseline covers 1,000 projects, 1,000
      tasks and 1,000 events (3,000 total; Gate 18A, `0d01ba3`).
- [x] 10,000 records if plausible for creator use — plausibility assessed against the
      v1 contract: this is a read-only workspace with no stated 10,000-record creator
      workload or performance SLA, and the defined baseline tops out at 1,000 per
      kind. No 10,000-record benchmark is claimed; reopen this row only if a creator
      requirement makes that scale concrete (Gate 18K, follow-up).
- [x] deep project folders — 200 deterministic project folders each contain a
      five-level nested content tree; only the one-level index is discovered, with
      folder provenance, linked-folder metadata, complete census accounting, and no
      phantom nested projects (Gate 18I, follow-up).
- [x] large Markdown notes — a deterministic 12,000-line Markdown body (>250 KiB)
      is loaded without truncating body-derived descriptions; explicit frontmatter
      descriptions still win, with complete census accounting and no problems (Gate
      18J, follow-up).
- [x] many events in one month — 1,000 deterministic events concentrated in one
      month are grouped with complete single-/multi-day coverage and a broad
      non-SLA timing guard (Gate 18C, follow-up to `622953e`).
- [x] many running Elastic tasks — 1,000-task headless timeline + card-height path
      is covered after indexing the timeline lookup (Gate 18B, `622953e`).
- [x] many canvas nodes — 1,000 passive canvas nodes render through the bounded
      headless string surface with complete node/card identity accounting and a
      broad non-SLA timing guard (Gate 18F, follow-up).
- [x] many unsupported file cards — 1,000 unknown-extension cards stay on the
        passive fallback path with complete node accounting and no content/authority
        leakage, under a broad non-SLA headless timing guard (Gate 18G, follow-up).
- [x] large Excalidraw scene — a 5,001-element deterministic scene is rendered
        headlessly with the 5,000-element budget enforced, explicit skipped-element
        diagnostics, complete census accounting, and stable output (Gate 18H, follow-up).
- [x] cold load measured — in-memory headless load timing is guarded below five
      seconds at both scales; this is a broad non-SLA regression guard (Gate 18A,
      `0d01ba3`).
- [x] refresh measured — unchanged and one-record-changed refresh timing is guarded
      for the 1,000-per-kind source, with revision/content assertions (Gate 18A,
      `0d01ba3`).
- [x] no unbounded polling — `RefreshPolicy` clamps intervals, owns one timer,
      suspends while hidden, coalesces in-flight triggers, and disposes cleanly;
      policy tests pin those bounds (Gate 18D, existing 6.1 evidence).
- [x] no unbounded event/log buffers — the action transcript uses the bounded
      `EventRing` (default capacity 128, configurable finite capacity) and evidence,
      diagnostics and canvas registries have explicit bounds; ring eviction is pinned
      by `tests/eventRing.test.ts` (Gate 18D).
- [x] no quadratic operation accidentally tied to every render — reachable read-only
      Board/Calendar/Canvas/inspection paths are source-audited and the two concrete
      nested scans were replaced by render-scoped indexes (`1b0a1bc` project labels;
      `85b56a4` inspection event day keys). The claim is scoped to current paths and
      does not include browser-DOM timing or unmeasured larger scales (Gate 18E).

Performance work must not move domain/file semantics into Papers.

---

## Gate 19 — Error and recovery behavior

- [x] missing vault grant — no-restored-handle fallback is explicit and does not
      query permission (`tests/handleBootstrap.test.ts`).
- [x] revoked FSA permission — prompt/denied permission and permission loss remain
      explicit, avoid reads, degrade last-good state, and recover on restart
      (`tests/handleBootstrap.test.ts`, `tests/startupSession.test.ts`).
- [x] inaccessible directory — present-but-unreadable traversal is `failed`/error,
      genuinely absent is `absent`/warning, and unknown presence fails closed
      (`tests/candidateAccounting.test.ts`, `tests/transportCompleteness.test.ts`).
- [x] malformed record — records remain visible with bounded validation problems and
      malformed refresh preserves the last-good snapshot (`tests/validation.test.ts`,
      `tests/refreshController.test.ts`).
- [x] duplicate ID — the later candidate is rejected with a stable `duplicate-id`
      error and deterministic winner (`tests/identity.test.ts`).
- [x] unsupported frontmatter — unsupported syntax is reported without silently
      rewriting or dropping the record (`tests/frontmatter.test.ts`,
      `tests/validation.test.ts`).
- [x] corrupted Excalidraw — decode/shape failures return bounded problems and no
      partial scene (`tests/excalidraw.test.ts`).
- [x] missing linked file — unresolved or unreadable embedded assets degrade to a
      visible bounded outcome while other assets continue (`tests/excalidrawAssets.test.ts`,
      `tests/excalidrawAssetLoader.test.ts`, `tests/excalidrawRender.test.ts`).
- [x] moved/renamed file — explicit identity survives a path move and refresh classifies
      the change as `renamed` (`tests/identity.test.ts`, `tests/refreshController.test.ts`).
- [x] deleted project — refresh removes the record and clears a stale selection with
      no ghost events (`tests/refreshIntegration.test.ts`, `tests/externalDirectoryVault.test.ts`).
- [x] source changes during read — concurrent refreshes serialize and a stale older
      result cannot overwrite the newer source (`tests/refreshController.test.ts`).
- [x] renderer crash — the selected surface renderer is wrapped in a pure boundary
      that returns escaped role-alert fallback markup, stable `renderer-failure` state,
      bounded detail and clean recovery (`src/browser/renderBoundary.ts`,
      `tests/renderBoundary.test.ts`).
- [x] failed refresh — unreadable and malformed refreshes return structured outcomes,
      preserve last-good data, and recover after repair (`tests/refreshController.test.ts`,
      `tests/refreshIntegration.test.ts`).
- [x] failed thumbnail — object-URL quota/invalid-URL failures keep the prior preview,
      reject the new preview, and revoke only owned URLs (`tests/canvasPreview.test.ts`).
- [ ] failed native open/reveal
- [ ] stale write if writes exist

For every checked defined-scope read-only error above:

- [x] structured code — failure paths use the documented problem/outcome vocabulary,
      including `preview-install-failed` and `renderer-failure`, with focused coverage
      in `tests/canvasSurface.test.ts` and `tests/renderBoundary.test.ts`.
- [x] user-readable explanation — diagnostics retain bounded explanatory details while
      surfaces render safe fallback/status text (`tests/inspection.test.ts`,
      `tests/canvasSurface.test.ts`, `tests/renderBoundary.test.ts`).
- [x] agent-readable state — inspection/health projections and the renderer boundary
      expose bounded status, problem codes and settled/degraded/failure state
      (`tests/inspection.test.ts`, `tests/readOnlyProjection.test.ts`,
      `tests/renderBoundary.test.ts`).
- [x] no silent data loss — candidate and Excalidraw census equalities plus last-good
      refresh snapshots account for rejected, skipped and unavailable data
      (`tests/candidateAccounting.test.ts`, `tests/excalidrawRender.test.ts`).
- [x] no automatic destructive repair — v1 is read-only and failure handling never
      writes or migrates source files (`tests/zeroWriteWitness.test.ts`,
      `tests/obsidianCoexistence.test.ts`).

---

## Gate 20 — Security boundary audit

Backpack page:

- [ ] still sandboxed — OPEN: the host/embed containment primitive (Papers
      `papers-backpack://` CSP/container policy) is outside this repository's
      browser source and has no exact host configuration or acceptance evidence here;
      the standalone loopback viewer is explicitly not a Papers sandbox claim.
- [x] no Node — the production source graph and emitted browser modules contain no
      Node builtin imports or Node runtime globals (`tests/browserBoundary.test.ts`).
- [x] no arbitrary code execution bridge — production source and emitted browser
      modules contain no eval/Function construction, script-element injection,
      JavaScript URLs or event-handler attribute sinks; the scanner self-test covers
      each forbidden entry point (`tests/browserBoundary.test.ts`).
- [x] no unrestricted network — the sole browser fetch adapter is loopback-checked,
      rejects foreign URLs before any request, and uses credentialless GET only
      (`tests/httpDirectory.test.ts`, `tests/presencePropagation.test.ts`).
- [x] no unrestricted machine path access — vault locators reject POSIX, Windows-drive,
      UNC, `file:` URL, traversal and malformed paths; FSA evidence accepts only
      bounded relative entries, and the bridge confines every requested path beneath
      its configured vault root, failing closed on traversal/drive and symlink escapes
      (`tests/canvas.test.ts`, `tests/fsaEvidence.test.ts`, `tests/agentVaultBridge.test.ts`,
      `tests/bridgeDisclosure.test.ts`).
- [x] arbitrary HTML/JS dropped on canvas remains passive — active extensions are
      rejected before payload reads and render only escaped fallback metadata; hostile
      script/iframe/JavaScript bytes never enter the surface (`tests/canvasSurface.test.ts`).
- [x] untrusted Markdown does not gain host authority — hostile Markdown loaded as a
      record body remains literal data in the browser text presentation: HTML/script,
      `javascript:` links, `file:` paths and bridge-looking URLs are escaped and never
      become DOM links, filesystem reads, network calls, bridge invocations or code
      execution (`tests/markdownAuthority.test.ts`, `tests/canvasSurface.test.ts`).

Filesystem:

- [x] all external access creator-granted or fixture-scoped — fixture bytes are the
      default; external readers exist only through an explicitly injected directory/
      reader or an already-restored handle whose read permission is queried. The
      loopback bridge also requires an explicit base URL/root; no production path
      crawls or guesses a machine directory
      (`src/browser/sourceFactory.ts`, `src/app/handleBootstrap.ts`,
      `tests/handleBootstrap.test.ts`, `tests/httpDirectory.test.ts`).
- [x] no traversal — OPFS/external-directory locators reject `..`/`.` traversal
      before handle lookup across list/walk/read/exists; bridge reads fail closed on
      traversal and resolved-root escapes, with symlink components rejected
      (`tests/externalDirectoryVault.test.ts`, `tests/agentVaultBridge.test.ts`,
      `tests/bridgeDisclosure.test.ts`, `tests/canvas.test.ts`, `tests/fsaEvidence.test.ts`).
- [x] symlink/junction containment explicitly tested where host capability exists —
      the bridge rejects intermediate linked directories for list and binary reads,
      while the bridge-backed acceptance exercises dangling links without erasing
      adjacent records; link-dependent tests fail loudly when the host cannot create
      the required link
      (`tests/bridgeDisclosure.test.ts`, `tests/transportCompleteness.test.ts`).
- [x] revocation works — after an injected external-directory handle reads
      successfully, a denied handle makes the next refresh fail closed with an
      `unreadable` outcome and `stale` last-good state rather than silently
      reacquiring authority (`tests/externalDirectoryVault.test.ts`).
- [ ] grant ownership is exact Backpack identity — OPEN: this repository tests
      wrong-handle rejection in the bounded clean-profile evidence, but does not own
      the native Papers/FSA origin registry or prove that a persisted grant cannot be
      borrowed by another Backpack identity; the machine-local `project.json` binding
      is not substituted for that host acceptance (`tests/cleanProfileAcceptance.test.ts`).
- [x] stale references fail closed — one-shot browser-file nodes retain their
      Proxima identity but become `unavailable` after restart/read failure rather
      than rebinding by filename, and deleted source records are removed from the
      refreshed projection without a ghost selection (`tests/canvasFileAdmission.test.ts`,
      `tests/refreshIntegration.test.ts`).

Developer control:

- [x] dev-only transport absent in ordinary production launch — ordinary fixture
      builds set `agentBridgeEnabled: false`, so `?bridge=` is ignored; resolving
      the bridge requires an explicit `PROXIMA_AGENT_BRIDGE=1` build opt-in
      (`src/browser/agentBridge.ts`, `tools/build-fixture-module.mjs`,
      `tests/agentBridgeBoundary.test.ts`).
- [ ] authenticated — OPEN: the explicitly enabled loopback bridge has origin/Host
      and build-opt-in defenses, but no bearer credential, shared secret or other
      caller authentication; loopback reachability is not treated as identity.
- [ ] exact surface targeting — OPEN: no live developer-control relay or external
      actuation endpoint exists in the defined scope, so there is no authenticated
      target/session selector whose isolation can be accepted; the loopback bridge
      is read-only source transport and internal action-dispatcher tests are not
      substituted for cross-surface control evidence.
- [x] bounded data — the enabled bridge caps directory entries, recursion depth,
      text/binary file bytes and returns only bounded error codes; inspection,
      evidence and diagnostics also cap item counts and field lengths
      (`tests/agentVaultBridge.test.ts`, `tests/inspection.test.ts`,
      `tests/evidence.test.ts`, `tests/cleanProfileAcceptance.test.ts`).
- [x] no arbitrary renderer JS — the enabled bridge exposes only fixed read-only
      JSON/data endpoints and no code-bearing renderer/control surface; source and
      emitted browser modules contain no eval/Function construction, script-element
      injection, JavaScript URLs or event-handler sinks, with scanner self-tests
      covering each forbidden entry point (`tests/agentVaultBridge.test.ts`,
      `tests/browserBoundary.test.ts`).
- [x] no creator-vault mutation by default — the enabled bridge is GET/OPTIONS-only;
      POST/PUT/PATCH/DELETE and mutation-shaped routes fail closed, while the
      read-only source/action layers expose no writer methods (`tests/agentVaultBridge.test.ts`,
      `tests/zeroWriteWitness.test.ts`, `tests/obsidianCoexistence.test.ts`).
- [x] an agent record write is a store operation, not a vault capability — the first
      agent-facing write entry resolves the sanctioned record write path (memory, fixture or
      activated OPFS store) and submits a record verb with a required observed revision, so an
      authenticated agent gains a record write and no filesystem reach: the bridge stays
      read-only GET/OPTIONS transport, the dispatcher still refuses every record verb, creator
      vault write authority stays disabled, and a stale submission is refused with the revision
      that beat it (`tests/agentWritePath.test.ts`, `docs/DECISIONS.md#d73`).
- [x] no secrets in evidence/logs — defined disclosure surfaces emit no absolute
      creator paths or raw filesystem errors, and there is no credential/token
      mechanism to leak; bridge failures, startup output, inspection/evidence
      projections and clean-profile reports stay within bounded redacted fields
      (`tests/bridgeDisclosure.test.ts`, `tests/inspection.test.ts`,
      `tests/evidence.test.ts`, `tests/cleanProfileAcceptance.test.ts`).

---

## Gate 21 — Documentation and durable handoff

Current truth stays in-repo.

- [x] architecture boundary — `AGENTS.md`, `README.md`
- [x] creator-data safety policy — `AGENTS.md`
- [x] exact supported vault formats — `docs/VAULT-FORMATS.md`
- [x] legacy compatibility behavior — `docs/VAULT-FORMATS.md`
- [x] preferred new format — `docs/VAULT-FORMATS.md`
- [x] frontmatter support/limitations — `docs/VAULT-FORMATS.md`
- [x] domain IDs vs source references — `docs/VAULT-FORMATS.md`
- [x] Elastic algorithm semantics _(Gate 1C)_ — fixed work reserves first,
      weighted remainder is independently capped without redistribution, and
      expired/invalid windows fail closed (`docs/VAULT-FORMATS.md`,
      `tests/elastic.test.ts`).
- [x] timezone semantics _(Gate 1C)_ — calendar grouping is inclusive in the
      machine-local civil timezone with calendar-date arithmetic; UTC-stable keys
      remain explicitly deferred (`docs/VAULT-FORMATS.md`,
      `tests/calendarDerivation.test.ts`, `tests/calendarGrid.test.ts`).
- [x] fixture conventions — `docs/VAULT-FORMATS.md`
- [x] action protocol _(Gate 3)_ — semantic actions, rejection codes and state
      revisions are defined in `src/app/actionProtocol.ts` and pinned by
      `tests/actionProtocol.test.ts`.
- [x] inspection protocol _(Gate 3)_ — renderer-independent bounded projections,
      provenance and degraded/settled health are defined in
      `src/app/inspection.ts` and pinned by `tests/inspection.test.ts`.
- [x] event protocol _(Gate 3)_ — versioned bounded event-ring records and cursors
      are defined in `src/app/eventRing.ts` and pinned by `tests/eventRing.test.ts`.
- [x] build identity format _(Gate 2)_ — generated identity carries version, exact
      SHA, schema versions, fixture/lock hashes and fixed clock
      (`tools/build-fixture-module.mjs`, `tests/evidence.test.ts`).
- [x] evidence format _(Gate 3)_ — schema-versioned, bounded, JSON-safe scenario
      evidence and validation are defined in `src/app/evidence.ts` and pinned by
      `tests/evidence.test.ts`.
- [x] FSA limitations _(Gate 5)_ — clean-profile evidence is bounded and relative-only;
      native Papers/FSA grant ownership and native FSA/Papers-hosted creator-vault
      acceptance remain explicitly OPEN
      (`docs/DECISIONS.md`, `tests/cleanProfileAcceptance.test.ts`).
- [x] Papers capabilities actually required _(ledger below)_ — the ledger records
      only justified triggers; no additional Papers capability is required by the
      defined read-only scope (`docs/DECISIONS.md`, ledger below).
- [x] rejected architectures — `README.md`, `docs/DECISIONS.md`
- [x] Excalidraw compatibility level _(Gate 7 — direct-source display contract PASS)_
- [x] current read/write authority — `AGENTS.md`, status table above
- [ ] exact currently validated Papers SHA — OPEN: the repository records a machine-
      local Papers baseline, but this run has no fresh exact running-Papers acceptance
      artifact to promote to PASS _(Gate 2)_.
- [x] exact test commands — `README.md`
- [x] known deferred items — this document

---

## Gate 22 — Release readiness

- [x] clean clone builds — a fresh local clone with no working-tree artifacts
      completed `npm ci` and `npm run build` successfully at the reviewed tree.
- [x] all tests pass — `npm test` completed 65 test files / 475 tests successfully
      on the current tree (including the real bridge, filesystem and browser-boundary
      regressions).
- [x] typecheck passes — `npm run typecheck` regenerated fixture/build identity and
      passed both application and test TypeScript projects (`tsconfig.json` and
      `tsconfig.tests.json`) on the current tree.
- [x] deterministic fixture scenarios pass — bundled fixture bytes are regenerated
      from the checked-in fixtures with fixed clock/identity seeds, and deterministic
      load, refresh, calendar, scale and action scenarios pass in the full suite
      (`tests/fixtures.ts`, `tests/performanceScale.test.ts`, `tests/actionProtocol.test.ts`,
      `tests/calendarGrid.test.ts`).
- [ ] C1 integrated scenarios pass — OPEN: headless browser render and semantic-key
      tests pass, but this run has no fresh exact capture/inspection artifact from
      a running Papers C1 surface; standalone string assertions are not substituted
      for host-integrated C1 acceptance.
- [ ] real FSA read-only acceptance passes — OPEN: disposable FSA capability,
      persistence and full-process restart evidence are recorded, but the clean-profile
      native picker/grant has not been performed in this run. The real creator-vault
      read-only acceptance therefore remains gated on a foreground gesture; no
      headless/OPFS/bridge result is substituted (`Gate 5.1`,
      `tests/cleanProfileAcceptance.test.ts`, `docs/DECISIONS.md#d21`).
- [ ] representative real Obsidian vault acceptance passes — OPEN: the signed Gate 6R
      substages cover disposable/bridge-backed read-only coexistence and Obsidian
      process observations, but the checklist still has no fresh native
      creator-vault/Obsidian acceptance artifact tied to the current build and grant.
      Disposable peer-writer evidence is not substituted for that host-integrated
      acceptance (`Gate 6.1L`, `Gate 6.1U`, `docs/DECISIONS.md#d36`).
- [x] Excalidraw display acceptance passes if included — Level A
      display/reference fidelity is signed PASS at exact Gate 7 SHA
      `7c22f6014c611ffbe6c7de093f1c75c886705ca3`: direct-source parse, bounded
      scene validation, linked-asset resolution and pure SVG rendering cover the
      accepted creator-vault subset (`tests/excalidraw.test.ts`,
      `tests/excalidrawAssets.test.ts`, `tests/excalidrawRender.test.ts`). Editing,
      round-trip writes, broad plugin compatibility and browser object-URL lifecycle
      remain explicitly deferred/not claimed.
- [x] arbitrary-file fallback acceptance passes if included — the defined Gate 8
      contract admits unknown/unsupported files as visible passive fallback cards,
      preserves filename/extension/size metadata, bounds acquisition, and turns
      missing binary capability, read failure, active content and oversized payloads
      into explicit fallback outcomes (`tests/canvasLoader.test.ts`,
      `tests/canvasSurface.test.ts`, `tests/canvasFileAdmission.test.ts`,
      `tests/canvasFallbackIcon.test.ts`). Durable external grants/directories,
      arbitrary SVG/PDF rendering and native open/reveal remain deferred.
- [x] exact build provenance recorded — `npm run build` completed at exact SHA
      `d8431bfc26c96cce7c31b0023c93f9bd964032c2`; generated fixture build identity
      reports Proxima `0.1.0`, `buildMode: fixture`, `agentBridgeEnabled: false`,
      domain/control/fixture schema versions `1/0/1`, fixture hash
      `ee92e5aec9093c2dcd22506d7b5cd86923b9fb8bb921441b712e5220f95565a0`, lockfile
      hash `3b36fa84bbf4e663b0547c3d7ff8577fef889f4a2fd0d80fb598694776b4d626`, and
      fixed clock `2026-09-06T12:00:00.000Z` (`tools/build-fixture-module.mjs`,
      `src/browser/generated/buildIdentity.generated.ts`).
- [x] no stale placeholder project identity — committed `project.json` carries the
      machine-minted Backpack id `bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1`, points to
      `public/index.html`, and matches the machine-local Papers registry binding
      recorded in the Gate 2A acceptance note; the README explicitly treats this UUID
      as non-portable machine-local state rather than a placeholder (`project.json`,
      `README.md`, Gate 2.1).
- [x] no unnecessary Papers changes — this release slice modifies only the Proxima
      repository; the reviewed commits contain no Papers checkout, host configuration,
      or native-host source changes, and the status table records `Papers changed: No`.
      The separate Papers host-change ledger remains deferred/unauthorized unless its
      exact trigger truth is later demonstrated.
- [x] every Papers change has a recorded specific missing truth and acceptance test —
      this release makes no Papers change. The host-change ledger below is the
      fail-closed policy for any future change: an entry must name one falsifiable
      missing truth and its concrete acceptance test/artifact, plus the reviewed SHA
      and result, before implementation is authorized.
- [x] creator real-vault write state is clearly documented as enabled or disabled —
      **Disabled** for this release: the browser, source/session pipeline and loopback
      bridge are read-only; mutation-shaped bridge requests fail closed, and the
      zero-write/coexistence witnesses assert no writer calls or source mutations
      (`AGENTS.md`, `README.md`, `tests/agentVaultBridge.test.ts`,
      `tests/zeroWriteWitness.test.ts`, `tests/obsidianCoexistence.test.ts`). Any
      future write gate requires explicit approval and a separate conflict model.
- [x] no known data-loss path in the defined read-only scope — candidate/Excalidraw
      census equalities account for rejected, skipped and unavailable data; failed
      refreshes preserve last-good state; stale selections are cleared rather than
      rebound; preview failures retain owned prior URLs; and zero-write witnesses
      reject source mutation (`tests/candidateAccounting.test.ts`,
      `tests/excalidrawRender.test.ts`, `tests/refreshController.test.ts`,
      `tests/refreshIntegration.test.ts`, `tests/canvasPreview.test.ts`,
      `tests/zeroWriteWitness.test.ts`). Native open/reveal and any future write path
      remain separate unchecked gates, so this row makes no native-write claim.
- [x] no test depends on arbitrary sleeps — Vitest refresh/session tests use injected
      schedulers and promise resolution, while the bridge tests use only bounded
      5-second startup deadlines that fail loudly if readiness is absent; no test
      assertion waits for a fixed sleep. The fixed delays in `tools/coexistence-run.mjs`
      are manual process-lifecycle orchestration, not test synchronization
      (`tests/refreshPolicy.test.ts`, `tests/sourceSession.test.ts`,
      `tests/startupSession.test.ts`, `tests/agentVaultBridge.test.ts`,
      `tests/bridgeDisclosure.test.ts`).
- [x] no test succeeds only by bypassing the real application action path — the
      browser binds every semantic `data-action` to the single project-owned
      `ActionDispatcher` (surface/project/calendar actions), while refresh actions
      go through the public refresh wiring and source session. Protocol, refresh,
      integration and inspection tests exercise those same dispatcher/session
      contracts, including accepted/rejected events and state replacement; no test
      invents a parallel UI mutation path (`src/browser/main.ts`,
      `src/app/actionProtocol.ts`, `src/browser/refreshWiring.ts`,
      `tests/actionProtocol.test.ts`, `tests/refreshIntegration.test.ts`,
      `tests/inspection.test.ts`). Full Papers-host click/capture acceptance remains
      the separate C1 OPEN row.

- [ ] line endings are part of the test contract — OPEN: several suites read source files
      as text and assert a literal containing `\n` - `tests/recordMutationContainment.test.ts`
      asserts a three-line import in `src/app/actionProtocol.ts` - while this machine has
      `core.autocrlf=true` (`git config core.autocrlf`) and the repository carries no
      `.gitattributes`. Git therefore hands a fresh Windows checkout CRLF, and that literal
      stops matching: checked by execution, the same literal is `true` against the LF working
      copy and `false` against a CRLF copy of the same bytes. The working tree here is mixed
      rather than consistent (92 tracked files CRLF and 41 mixed against an LF index), so the
      fix is a repository-wide line-ending decision rather than a local repair, and it is left
      to the creator instead of churning 133 files inside a slice about the agent write path.

### 22R Current-tree revalidation

This entry supersedes only those claims in Gate 22 that described its reviewed SHA as
the "current tree". The original Gate 22 evidence remains unchanged as historical
evidence for the build it actually recorded.

- [x] `npm run typecheck` passes at `071f8c3`.
- [x] `npm test` passes at `071f8c3`: 92 test files / 574 tests.
- [ ] Clean-clone `npm ci` + `npm run build` revalidated at `071f8c3`.
- [ ] Exact generated fixture-build provenance recorded for `071f8c3`.
- [ ] Fresh Papers-host C1 acceptance for `071f8c3`.
- [ ] Fresh native FSA creator-vault read-only acceptance for `071f8c3`.
- [ ] Fresh representative native creator-vault/Obsidian acceptance for `071f8c3`.

The unchecked host and native rows remain unchecked unless an artifact from the exact
`071f8c3` build exists. Older bridge, disposable, Gate 7 or Gate 13D2 evidence is not
silently promoted into current host-integrated acceptance.

---

## Papers host-change ledger

Maintained separately. **A host change is not authorized merely because it appears
here.**

Before any ledger item can move from deferred to implemented, record the exact
falsifiable trigger truth, the concrete acceptance test or host artifact that will
prove it, and the exact reviewed SHA/result. A capability without all three remains
unauthorized; listing a plausible future capability is not an acceptance test.

| ID | Capability | Trigger | Status |
| --- | --- | --- | --- |
| H1 | Project-scoped granted list/read/stat | "A Backpack cannot durably enumerate/read a creator-selected external directory using available browser capabilities." | Not justified until the FSA spike (Gate 5) fails |
| H2 | Bounded watch on granted roots/files | "Available browser refresh mechanisms cannot meet the required external-change latency." | Convenience / deferred |
| H3 | Open/reveal opaque granted-file reference | "A Backpack cannot hand an already-authorized file to the native/default application or Explorer." | Product-dependent |
| H4 | Conditional atomic write against observed revision/hash | "FSA cannot safely commit shared creator files without overwriting an external edit made after Proxima read them." | Required only if real-vault writing is eventually enabled and FSA is insufficient |
| H5 | Bounded native thumbnail for an authorized file | "Unsupported files need native thumbnail fidelity that Proxima cannot generate itself." | Convenience / deferred |
| H6 | Exact CSP primitive (e.g. `blob:` images, WASM) | "A bundled required library demonstrably fails because a specific fixed CSP directive blocks a necessary browser primitive." | Must be demonstrated, never speculative |
| H7 | Sidecar relay | "A chosen Proxima-owned sidecar needs authenticated communication unavailable under `connect-src 'none'`." | Do not pursue unless sidecar architecture becomes necessary |
| H8 | Dev-only exact-surface opaque project request/response relay | "An authenticated Papers developer-control connection must drive/inspect a live Proxima surface but has no bounded semantic request/response path into the project page." | Expected eventually; not before Proxima's own action and inspection contracts exist |
| H9 | Dev-only disposable fixture grant | "Clean-profile integrated tests must autonomously exercise a real external Windows directory and pre-granted FSA/OPFS/disk conformance layers are insufficient." | Avoid unless proved necessary |
| H10 | Semantic-key-targeted input actuation | "Tests must prove actual click/type interaction on semantic elements in the real Papers surface and standalone browser UI testing is insufficient." | Deferred |

---

## Recommended audit sequence for incremental pushes

Each pushed SHA is sent for audit approximately in this order.

1. [x] Gate 1A — legacy source discovery + logical/source identity correction
       _(signed off after the `type:` veto correction)_
2. [x] Gate 1B — frontmatter failure visibility + validation edge cases
       _(pushed, awaiting audit)_
3. [x] Gate 1C — Elastic/calendar edge-test closure
4. [x] Gate 2A — actual build + real Backpack identity + fixture boot
5. [x] Gate 2B — first visible board/projects/calendar + C1 keys
6. [x] Gate 3A — action dispatcher + inspection projection
7. [x] Gate 3B — revision/settling + event ring + evidence schema
8. [x] Gate 4 — adapter conformance: disk + OPFS
9. [x] Gate 5 — real Papers FSA spike (core viability and full-process lifecycle PASS;
       clean-profile and real-vault follow-ups remain open)
10. [x] Gate 6 — read-only creator vault (defined-scope PASS; native Papers-hosted,
       durable native FSA/picker lifecycle, native watcher and broader native-host
       acceptance remain OPEN)
11. [x] Gate 7 — Excalidraw display (direct-source display contract PASS)
12. [x] Gate 8 — arbitrary-file canvas (defined scope PASS; durable grants/directories, source SVG and PDF remain deferred)
13. [ ] Gate 9 — native open/reveal if justified
14. [ ] Gate 10 — Papers live semantic relay if justified
15. [ ] Gate 11 — complete integrated agent harness
16. [x] Gate 12 — external-change convergence (defined pull-refresh scope PASS;
       native watcher remains deferred unless a concrete latency requirement fails)
17. [x] Gate 13 — conditional writer, lifecycle and coexistence; native FSA is
       explicitly closed NO-GO while the adapter remains read-only
18. [x] Gate 14 — durable owner authority boundary is explicitly read-only;
       creator-vault writes remain deferred pending native transaction support
19. [ ] Gate 15+ — Excalidraw editing, richer previews, scale, hardening and release
