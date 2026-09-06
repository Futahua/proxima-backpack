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

## Current status

| Field | Value |
| --- | --- |
| Current slice | Gate 2B — first visible deterministic fixture surface |
| Branch | `codex/gate-1b-correction` (local acceptance worktree) |
| Last audited SHA | `3b5a391` — Gate 2A PASS; local Papers identity acceptance reported separately. |
| Papers changed | No |
| Papers baseline (exact) | `0a0d89f267f6ca1125159a8b0022c9a620f62e82` |
| Real-vault write authority | **Disabled.** Read-only until a separate write/conflict gate is approved. |

## Baseline, unless deliberately changed later

- Papers exact baseline: `0a0d89f267f6ca1125159a8b0022c9a620f62e82`
- Proxima repo: `Futahua/proxima-backpack`
- Obsidian remains a peer application.
- The vault remains canonical creator data.
- Proxima is read-only against the real vault until a separate write/conflict gate is
  explicitly approved.
- KeToan is permanently out of scope.
- Primary product surfaces: Elastic board, calendar, projects, then arbitrary-file /
  canvas work.
- Proxima must remain independently programmable and testable without depending on
  Papers or Obsidian internals.

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

- [ ] Define versioned project-owned action catalog.
- [ ] Actions express user/domain intent rather than UI mechanics.
- [ ] Human UI uses the same action dispatcher.
- [ ] Tests use the same action dispatcher.
- [ ] No test-only direct Svelte/store mutation path.
- [ ] Actions have stable machine-readable names.
- [ ] Action inputs are schema-validated.
- [ ] Action outputs are schema-validated.
- [ ] Errors have stable codes, not only prose.

Potential categories:

- [ ] navigation/select project
- [ ] board selection/filtering
- [ ] calendar navigation
- [ ] fixture reset/load
- [ ] refresh/reload source
- [ ] future canvas selection/open
- [ ] mutation actions remain fixture-only while real vault is read-only

### 3.2 State-inspection seam

- [ ] Define a versioned read-only inspection projection.
- [ ] It is independent of Svelte/store implementation.
- [ ] Includes:
  - [ ] build identity
  - [ ] mode: fixture/live
  - [ ] application state revision
  - [ ] current surface
  - [ ] current selection
  - [ ] project summaries
  - [ ] board/task summaries
  - [ ] calendar/event summaries
  - [ ] load problems
  - [ ] source revisions as safe logical metadata
  - [ ] pending operations
  - [ ] degraded/error state
  - [ ] latest event sequence
- [ ] Real-vault inspection redacts unnecessary machine information.
- [ ] Fixture inspection may include fixture-relative paths where useful.

### 3.3 Application revision and settling

- [ ] Define application-state revision.
- [ ] Revision changes deterministically when meaningful state changes.
- [ ] Define "idle" / "settled" semantics.
- [ ] Agent can tell when:
  - [ ] source read completed
  - [ ] derived state completed
  - [ ] render updated
- [ ] No tests rely on arbitrary sleeps.

### 3.4 Structured event ring

- [ ] Versioned event envelope.
- [ ] Monotonic sequence number.
- [ ] Event kind.
- [ ] Logical entity IDs.
- [ ] Operation/request ID where relevant.
- [ ] State revision after event where relevant.
- [ ] Injected timestamp.
- [ ] Bounded in-memory retention.
- [ ] `events.read(afterSequence)` or equivalent query.
- [ ] Events distinguish domain facts from diagnostic logs.

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

- [ ] Machine-readable scenario result schema.
- [ ] Includes:
  - [ ] scenario ID
  - [ ] Proxima build
  - [ ] Papers build/process identity
  - [ ] fixture hash
  - [ ] deterministic clock seed/value
  - [ ] ID seed/sequence configuration
  - [ ] action transcript
  - [ ] event transcript
  - [ ] initial state revision
  - [ ] final state revision
  - [ ] domain assertions
  - [ ] C1 visual assertions
  - [ ] diagnostic/timeline excerpts
  - [ ] capture artifact hashes/IDs
  - [ ] pass/fail result
- [ ] Evidence can be reproduced from a clean fixture run.

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

- [ ] list directory
- [ ] recursive walk
- [ ] read text
- [ ] exists
- [ ] revision changes after modification
- [ ] path normalization
- [ ] Unicode filenames
- [ ] spaces/punctuation
- [ ] nested directories
- [ ] missing file
- [ ] missing directory
- [ ] unreadable file behavior
- [ ] deterministic ordering
- [ ] large-but-reasonable file
- [ ] no traversal outside granted root

### 4.2 Memory adapter

- [ ] Clearly documented as an in-process adapter.
- [ ] Does not claim to test Windows/FSA semantics.
- [ ] Revision semantics are deterministic.
- [ ] Delete/recreate changes revision appropriately.
- [ ] Path normalization is covered.

### 4.3 Real disk fixture adapter for headless tests

- [ ] Run against actual fixture directories on disk.
- [ ] Real rename behavior.
- [ ] Real delete/recreate.
- [ ] Real mtime/content changes.
- [ ] External writer process can mutate fixture during test.
- [ ] Never point automated mutation tests at creator's real vault.

### 4.4 Browser OPFS adapter

- [ ] Same repository contract.
- [ ] Same conformance suite where semantics overlap.
- [ ] Browser-native `FileSystemDirectoryHandle` use tested without user picker.
- [ ] Explicitly document what OPFS cannot prove:
  - [ ] external Obsidian edits
  - [ ] Windows absolute paths
  - [ ] cross-process contention
  - [ ] user-granted external directory persistence

### 4.5 Gate 4 exit

- [ ] Core repository contract is proven across at least memory + real fixture disk +
      OPFS.
- [ ] No Papers host change required.

---

## Gate 5 — Real File System Access spike in Papers

Disposable data only.

### 5.1 Capability proof

Inside the real `papers-backpack://` surface:

- [ ] `showDirectoryPicker({mode:'readwrite' or read as appropriate})` availability
      proven.
- [ ] User gesture requirement recorded.
- [ ] Selected directory can be enumerated.
- [ ] Files can be read.
- [ ] Current on-disk state is observed after external edits.
- [ ] Handle can be stored in IndexedDB.
- [ ] Restart behavior tested.
- [ ] `queryPermission()` state after restart recorded.
- [ ] `requestPermission()` behavior recorded.
- [ ] Clean-profile behavior recorded.

### 5.2 Read-only real vault

- [ ] Grant actual creator vault manually.
- [ ] Proxima reads through the same repository contract.
- [ ] No writes.
- [ ] No migration.
- [ ] No automatic reorganization.
- [ ] Legacy source fixture and creator data agree on semantics.
- [ ] External Obsidian edit becomes visible after refresh/reload.
- [ ] Rename/delete behavior is observable and safe.

### 5.3 FSA decision

- [ ] FSA is sufficient for v1 read-only access; or
- [ ] Specific failed acceptance test proves it is insufficient.

If insufficient, state the missing truth exactly before asking Papers for anything.
Possible specific truth:

- [ ] Backpack cannot durably enumerate/read a creator-selected external directory
      using available browser capabilities.

Only then consider a project-scoped external read capability in Papers.

---

## Gate 6 — Read-only real-vault product surface

### 6.1 Source refresh model

- [ ] Manual refresh exists.
- [ ] Refresh-on-focus considered/tested.
- [ ] Bounded polling considered/tested if needed.
- [ ] External edit produces new source revision.
- [ ] Deleted source disappears or becomes explicit missing state.
- [ ] Renamed source follows defined identity semantics.
- [ ] UI never shows stale state as confirmed-current without indication.

### 6.2 Elastic board

- [ ] Correct projects available.
- [ ] Correct task filtering.
- [ ] Correct three-column derivation.
- [ ] Ordering preserved.
- [ ] Elastic heights match pinned domain timeline.
- [ ] Fixed-duration behavior visible.
- [ ] `maxDuration` cap behavior visible.
- [ ] Expired deadline behavior visible.
- [ ] No mutation to real vault.

### 6.3 Calendar

- [ ] Task/schedule project separation correct.
- [ ] Multi-day events render across all covered days.
- [ ] Calendar navigation deterministic.
- [ ] Invalid events surface safely.
- [ ] Timezone behavior matches chosen semantics.
- [ ] No mutation to real vault.

### 6.4 Projects

- [ ] Flat and subfolder legacy projects display correctly.
- [ ] Project description/body reads correctly.
- [ ] Linked folders display correctly.
- [ ] Archived state displays correctly if retained.
- [ ] Project source provenance available for diagnostics/opening later.

### 6.5 Real-vault safety

- [ ] No writer implementation wired.
- [ ] No hidden write through browser APIs.
- [ ] No migration on boot.
- [ ] No auto-fix of frontmatter.
- [ ] No destructive agent commands against creator vault.
- [ ] Fixture mode remains the default mutable automation environment.

---

## Gate 7 — Excalidraw display compatibility

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

- [ ] Canvas node identity is Proxima-owned and stable.
- [ ] Node identity is not renderer type.
- [ ] Node can reference:
  - [ ] vault file
  - [ ] granted external file
  - [ ] directory if supported
- [ ] Source locator/provenance is distinct from canvas node ID.
- [ ] Position/layout independent of source path.
- [ ] Rename/delete behavior specified.
- [ ] Missing source remains a representable canvas state.

### 8.2 Renderer registry

- [ ] Markdown/text
- [ ] PNG/JPEG/WebP/SVG
- [ ] Excalidraw
- [ ] PDF if later added
- [ ] unknown file fallback
- [ ] no arbitrary executable HTML/JS simply because a file was dropped

### 8.3 "Any file" contract

- [ ] Every creator-selected file can exist as a canvas object.
- [ ] Only understood formats require inline preview.
- [ ] Unsupported format gets first-class fallback card.
- [ ] Fallback card can show available:
  - [ ] filename
  - [ ] extension
  - [ ] size
  - [ ] modified time
  - [ ] icon/thumbnail
  - [ ] missing/unavailable state
- [ ] Unsupported file is not treated as error just because no renderer exists.

### 8.4 Drag/drop

- [ ] Browser drop file can be previewed one-shot from `File`.
- [ ] Source identity semantics after restart specified.
- [ ] Dropped path does not become the only logical ID.
- [ ] Duplicate drops have defined behavior.
- [ ] Large file bounds exist.
- [ ] Active/executable content remains passive unless explicitly trusted.

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

- [ ] Detect or discover changed revision.
- [ ] Reload changed file.
- [ ] Update domain state.
- [ ] Maintain selection where identity survives.
- [ ] Handle source rename.
- [ ] Handle source deletion.
- [ ] Handle newly created records.
- [ ] Handle temporarily malformed file while Obsidian/plugin is saving.
- [ ] Never partially merge malformed source into confirmed state.

### 12.2 Refresh strategy decision

- [ ] refresh-on-focus
- [ ] explicit refresh
- [ ] bounded polling
- [ ] browser watcher availability if any

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

## Gate 13 — Write-model design, still disabled in production

Not enabled merely because a UI needs editing.

### 13.1 Conflict model

- [ ] observed source revision
- [ ] intended logical mutation
- [ ] serialize preserving unknown data
- [ ] checked commit
- [ ] stale result
- [ ] retry/merge/refuse policy
- [ ] rename conflict behavior
- [ ] deletion conflict behavior
- [ ] external Obsidian edit during Proxima edit
- [ ] two Proxima surfaces editing same source
- [ ] crash/power-loss behavior where relevant

### 13.2 Writer conformance

Fixture only initially.

- [ ] update ordinary task
- [ ] preserve body
- [ ] preserve unknown frontmatter
- [ ] preserve unsupported YAML/source text
- [ ] stale revision refuses
- [ ] concurrent external change refuses
- [ ] no accidental field reformatting beyond agreed scope
- [ ] Obsidian reopens resulting file normally
- [ ] Excalidraw/plugin-specific sections preserved exactly where required

### 13.3 Decide whether FSA writes are safe enough

- [ ] expected-revision check can be made meaningful.
- [ ] check-to-replace race is acceptable or not.
- [ ] Obsidian external writes cannot be silently overwritten.

If not, specific missing truth:

> "A Backpack that edits shared files cannot atomically commit only when the file still
> matches the revision it previously read."

---

## Gate 14 — First real-vault write

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

- [ ] same fixture in two surfaces
- [ ] same real vault in two surfaces
- [ ] refresh in one converges appropriately in the other
- [ ] navigation/selection independence specified
- [ ] source revision model consistent
- [ ] no surface-local state accidentally written as canonical file state

### 17.2 If writes become enabled

- [ ] simultaneous Proxima edits tested
- [ ] stale writer refused
- [ ] unrelated-file edits preserved
- [ ] same-file conflict explicit
- [ ] last-writer-wins used only where intentionally specified

---

## Gate 18 — Performance and scale

- [ ] 100 records
- [ ] 1,000 records
- [ ] 10,000 records if plausible for creator use
- [ ] deep project folders
- [ ] large Markdown notes
- [ ] many events in one month
- [ ] many running Elastic tasks
- [ ] many canvas nodes
- [ ] large Excalidraw scene
- [ ] many unsupported file cards
- [ ] cold load measured
- [ ] refresh measured
- [ ] no unbounded polling
- [ ] no unbounded event/log buffers
- [ ] no quadratic operation accidentally tied to every render

Performance work must not move domain/file semantics into Papers.

---

## Gate 19 — Error and recovery behavior

- [ ] missing vault grant
- [ ] revoked FSA permission
- [ ] inaccessible directory
- [ ] malformed record
- [ ] duplicate ID
- [ ] unsupported frontmatter
- [ ] corrupted Excalidraw
- [ ] missing linked file
- [ ] moved/renamed file
- [ ] deleted project
- [ ] source changes during read
- [ ] renderer crash
- [ ] failed refresh
- [ ] failed thumbnail
- [ ] failed native open/reveal
- [ ] stale write if writes exist

For every error:

- [ ] structured code
- [ ] user-readable explanation
- [ ] agent-readable state
- [ ] no silent data loss
- [ ] no automatic destructive repair

---

## Gate 20 — Security boundary audit

Backpack page:

- [ ] still sandboxed
- [ ] no Node
- [ ] no arbitrary code execution bridge
- [ ] no unrestricted network
- [ ] no unrestricted machine path access
- [ ] arbitrary HTML/JS dropped on canvas remains passive
- [ ] untrusted Markdown does not gain host authority

Filesystem:

- [ ] all external access creator-granted or fixture-scoped
- [ ] no traversal
- [ ] symlink/junction containment explicitly tested where host capability exists
- [ ] revocation works
- [ ] grant ownership is exact Backpack identity
- [ ] stale references fail closed

Developer control:

- [ ] dev-only transport absent in ordinary production launch
- [ ] authenticated
- [ ] exact surface targeting
- [ ] bounded data
- [ ] no arbitrary renderer JS
- [ ] no creator-vault mutation by default
- [ ] no secrets in evidence/logs

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
- [ ] Elastic algorithm semantics _(Gate 1C)_
- [ ] timezone semantics _(Gate 1C)_
- [x] fixture conventions — `docs/VAULT-FORMATS.md`
- [ ] action protocol _(Gate 3)_
- [ ] inspection protocol _(Gate 3)_
- [ ] event protocol _(Gate 3)_
- [ ] build identity format _(Gate 2)_
- [ ] evidence format _(Gate 3)_
- [ ] FSA limitations _(Gate 5)_
- [ ] Papers capabilities actually required _(ledger below)_
- [x] rejected architectures — `README.md`, `docs/DECISIONS.md`
- [ ] Excalidraw compatibility level _(Gate 7)_
- [x] current read/write authority — `AGENTS.md`, status table above
- [ ] exact currently validated Papers SHA — baseline recorded above, but nothing has
      been validated against a running Papers yet _(Gate 2)_
- [x] exact test commands — `README.md`
- [x] known deferred items — this document

---

## Gate 22 — Release readiness

- [ ] clean clone builds
- [ ] all tests pass
- [ ] typecheck passes
- [ ] deterministic fixture scenarios pass
- [ ] C1 integrated scenarios pass
- [ ] real FSA read-only acceptance passes
- [ ] representative real Obsidian vault acceptance passes
- [ ] Excalidraw display acceptance passes if included
- [ ] arbitrary-file fallback acceptance passes if included
- [ ] exact build provenance recorded
- [ ] no stale placeholder project identity
- [ ] no unnecessary Papers changes
- [ ] every Papers change has a recorded specific missing truth and acceptance test
- [ ] creator real-vault write state is clearly documented as enabled or disabled
- [ ] no known data-loss path
- [ ] no test depends on arbitrary sleeps
- [ ] no test succeeds only by bypassing the real application action path

---

## Papers host-change ledger

Maintained separately. **A host change is not authorized merely because it appears
here.**

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
4. [ ] Gate 2A — actual build + real Backpack identity + fixture boot
5. [ ] Gate 2B — first visible board/projects/calendar + C1 keys
6. [ ] Gate 3A — action dispatcher + inspection projection
7. [ ] Gate 3B — revision/settling + event ring + evidence schema
8. [ ] Gate 4 — adapter conformance: disk + OPFS
9. [ ] Gate 5 — real Papers FSA spike
10. [ ] Gate 6 — read-only creator vault
11. [ ] Gate 7 — Excalidraw display
12. [ ] Gate 8 — arbitrary-file canvas
13. [ ] Gate 9 — native open/reveal if justified
14. [ ] Gate 10 — Papers live semantic relay if justified
15. [ ] Gate 11 — complete integrated agent harness
16. [ ] Gate 12 — external-change convergence
17. [ ] Gate 13 — write model, fixture-only
18. [ ] Gate 14 — first real-vault write, only after explicit approval
19. [ ] Gate 15+ — Excalidraw editing, richer previews, scale, hardening and release
