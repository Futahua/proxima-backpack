# Vault formats Proxima reads

Two layouts are supported and both are read exactly where they are. **Nothing in this
document describes a migration**, because there is no migration: a reader that has to
rewrite a file before it can understand it is a writer, and Proxima does not write to
the vault.

## The preferred layout

One Markdown file per record, under a configurable root. `Proxima` is the default.

```
<root>/projects/{id}.md
<root>/projects/{id}/index.md
<root>/tasks/{id}.md
<root>/events/{id}.md
```

This stays the canonical Proxima-native layout. A new vault should look like this; an
old one is never required to.

## The legacy compatibility layout

The Obsidian plugin defaulted to a hidden folder, and real creator vaults still use it:

```
-Hide/Proxima/projects
-Hide/Proxima/tasks
-Hide/Proxima/events
```

Both layouts map into the same domain model. Nothing above the reader — no selector, no
future UI — can tell which one produced a record, and nothing above the reader is
allowed to ask.

### Directories are configured independently

The layout is three directories, not one root, because a real vault may have been
rearranged by hand — tasks moved out of the hidden folder, events left behind. A
configuration that could only express "one root" would force a migration in order to
read data that is already fine.

```ts
resolveLayout({ root: '-Hide/Proxima', layout: { tasks: 'Proxima/tasks' } });
```

An explicit directory always wins over the root.

## Discovery: what counts as a record

Discovery is **positional**. A file's location decides what it is.

| Path | Read as | Logical id from |
| --- | --- | --- |
| `projects/{name}.md` | project | the filename |
| `projects/{name}/index.md` | project | the folder name |
| `projects/{name}/anything-else.md` | nothing | — |
| `projects/a/b/index.md` | nothing | — |
| `tasks/{name}.md` | task | the filename |
| `events/{name}.md` | event | the filename |
| `tasks/sub/{name}.md` | nothing, and reported | — |

Two consequences worth stating plainly:

- **A project folder may contain the project's own notes.** Extra Markdown beside an
  `index.md` is content, not a second project. This is the common case in a real
  vault and is silently correct, not a warning.
- **Markdown below `tasks/` or `events/` is reported, not ignored.** No supported
  layout puts a task in a subfolder, so a file sitting there is more likely misplaced
  than deliberate, and a silently missing task is worse than a warning.

### `type:` in frontmatter — projects only

The plugin's project scan required `type: project`. Its task and event loaders never
looked at `type` at all. The reader matches that, exactly:

| Directory | `type:` absent | `type: project` | any other value |
| --- | --- | --- | --- |
| `projects/` | read as a project | read as a project | **vetoed**, reported as `unexpected-type` |
| `tasks/`, `events/` | read | read | read |

So the marker is honoured where it meant something and ignored where it never did. On a
task or an event, `type:` is ordinary frontmatter — the creator's own field, or another
plugin's — and is carried, not obeyed. A legacy task saying `type: todo` loads as a
task; an event saying `type: meeting` loads as an event.

For projects the marker survives only as a **veto**, never as a requirement: discovery
is still positional, so `type: project` neither promotes a file the rules skipped nor is
needed by a file they found. Its one job is to let a note the creator filed in
`projects/` opt out by saying what it is.

**Known boundary:** a stray note in `projects/` that declares no `type` *will* be read
as a project. The flat legacy format is `projects/{id}.md` with no required marker, so
there is nothing in the bytes that distinguishes the two. This is a property of the
format, not a bug in the reader, and the `type:` veto is the escape hatch.

## Identity

A record's **logical id** and the **path of the file it came from** are different
things. Conflating them is the specific defect this reader was rewritten to remove:
when the path is the identity, moving a file silently creates a new record and renaming
one silently destroys the old.

The id is resolved in one of three ways, recorded on every record as
`source.idOrigin`:

| `idOrigin` | Meaning | Survives a rename? |
| --- | --- | --- |
| `frontmatter` | the file declares `id:` | **yes** |
| `filename` | derived from the file's own basename | no |
| `folder` | derived from the containing folder, for `index.md` | no |

An explicit `id:` wins unconditionally. A file with no declared id falls back to its own
name — the legacy convention — and that fallback does move when the file moves, because
there is nothing else it could be identified by.

### Provenance

Every loaded record carries a `source`:

```ts
interface SourceRef {
  path: string;      // vault-relative, forward-slashed
  revision: string;  // opaque; changes when the file changes
  kind: 'project' | 'task' | 'event';
  idOrigin: 'frontmatter' | 'filename' | 'folder';
}
```

Agent-visible ids, board keys and future semantic visual keys use the **logical id**,
never a path and never an array position.

### Duplicate ids

Two records of the same kind resolving to the same logical id is an error, not a
tiebreak. The first in path order enters state; the second is **rejected** and reported
as `duplicate-id`, naming the file that already holds the id.

Path order is lexicographic and the candidate list is sorted before reading, so the
winner is a rule rather than a race — the same vault produces the same result and the
same report on every run.

Ids are unique **per kind**. A project and a task may share an id without colliding;
they live in separate collections and a `projectId` only ever refers to a project.

## Field compatibility

| Concept | Preferred | Also read |
| --- | --- | --- |
| project reference | `project: proj-x` | `projectId: proj-x` |
| linked folders | `linkedFolders: [Drawings, Notes]` | `linkedFolder: Drawings` |
| linked folders (legacy packed) | — | `linkedFolders: Art\|Drawings/Art;Refs\|Refs/Studio` |

The packed form is one scalar carrying `Name|path` pairs separated by `;`. To YAML it is
just a string; only the field knows it means more, so it is unpacked in the reader
rather than in the frontmatter parser.

A record referencing a project that did not load is reported as `missing-project`
rather than being filed under "uncategorised" — a broken link and a deliberate absence
of a project are different facts, and the creator should be able to tell them apart.

## Frontmatter

Proxima reads a documented subset of YAML, not all of it. What matters more than the
size of the subset is that the parser **knows what it does not understand**: a construct
outside the subset leaves its key unset and produces a problem naming the line. A
missing field is something the reader can report; a wrong field is something nobody
notices.

### Supported

| Form | Example | Read as |
| --- | --- | --- |
| plain scalar | `name: Studio` | `"Studio"` |
| number | `weight: 3`, `offset: -2`, `ratio: 1.5` | number |
| version/date-like token | `version: 1.2.3`, `day: 2026-09-06` | string, never a number |
| boolean | `done: true`, `done: TRUE` | boolean |
| null | `project: null`, `project: ~` | `null` |
| quoted string | `colour: "#00b894"`, `name: 'Studio'` | unquoted; double quotes support `\"`, `\\`, `\n`, and `\t` |
| inline list | `tags: [a, b]`, `tags: ["a,b", c]` | array |
| block list | `tags:`<br>`  - alpha` | array |
| empty value | `description:` | `""` |
| comment | `weight: 3 # note`, whole-line `# note` | stripped |

`true` and `false` are booleans in any case. **`yes`, `no`, `on` and `off` stay
strings** — js-yaml 4, which Obsidian reads these files with, treats them as strings,
and agreeing with the peer application matters more than agreeing with YAML 1.1. A
field that needs a boolean and gets `yes` is reported (see the validation table below).

A `#` only starts a comment when whitespace precedes it, so `colour: "#00b894"` and
`anchor: page#section` are untouched.

A UTF-8 BOM before the opening fence is stripped. Left in place it hides the entire
frontmatter block, and the record loads with every field defaulted and nothing to say
why.

### Not supported — reported, never guessed

| Form | Issue code | What happens |
| --- | --- | --- |
| nested mapping / block mapping | `nested-mapping` | the parent key is left unset; **child keys are never hoisted** |
| list of mappings | `list-of-mappings` | the key is left unset |
| `|` or `>` multiline scalar | `block-scalar` | the key is left unset |
| `{ ... }` flow mapping | `flow-mapping` | the key is left unset |
| `&anchor` / `*alias` | `anchor-or-alias` | the key is left unset |
| nested or unterminated inline list | `unterminated-list` | the key is left unset |
| unsupported double-quoted escape | `unsupported-escape` | the key is left unset; no backslash or following character is silently changed |
| the same key twice | `duplicate-key` | the **first** wins, as with duplicate ids |
| anything else non-blank | `unparsable-line` | the line is skipped |

Parsing continues after an unsupported construct: one bad key does not cost the rest of
the file.

Double-quoted strings deliberately support only `\"`, `\\`, `\n`, and `\t`. YAML's
Unicode/hex escapes and any invalid escape are reported rather than partly decoded.
For example, `"caf\u00e9"`, `"bad\q"`, and `"C:\Users\Ana"` are left unset with an
`unsupported-escape` issue. Full YAML escape handling remains part of the Gate 13 parser
re-evaluation; this read-only subset must never mutate text it cannot interpret.

The hoisting case is the one that motivated this. Given

```yaml
id: task-nested
meta:
  id: task-hijacked
  status: review
```

the previous parser produced `{ meta: [], id: task-hijacked, status: review }` — the
nested keys replaced the record's own identity. Now `meta` is unset and reported, and
`id` stays `task-nested`.

### Raw text is preserved

`ParsedDocument` carries `frontmatterRaw` byte-for-byte alongside the interpreted
values, and `lossy` is true whenever the two differ in content. A key Proxima does not
interpret survives untouched. **A writer must serialize from the raw text, never from
the interpreted projection** — see `docs/DECISIONS.md#d7`.

## Field validation

Reading a field and trusting it are different things. Each field has a range, and a
value outside it is replaced with something safe *and reported* — a card sized from a
default nobody chose looks exactly like a card sized from a real number.

| Field | Valid | Otherwise |
| --- | --- | --- |
| `weight` | finite, `> 0` | `1`, reported. Zero would claim no time while still occupying the board; negative would inflate every other card's share. |
| `orderIndex` | any finite number | `0`, reported |
| `fixedDuration` | absent, or finite `> 0` minutes | unset, reported. Negative would run the timeline cursor backwards over the previous task. |
| `maxDuration` | absent, or finite `> 0` minutes | unset, reported |
| `isFixedDuration`, `isCompleted` | `true` / `false` | the default, reported |
| task `status` | any non-empty identifier | `running`, reported |
| project `status` | `active` or `archived` | `active`, reported |
| project `projectType` | `task` or `schedule` | `task`, reported; invalid input must not silently route a project to the board |
| `createdAt` | a readable date | epoch, reported |
| `startDate`, `deadline` | absent, or a readable date | unset, reported |

An unknown-but-well-formed status is **not** a problem: the plugin let creators
configure their own, and `columnOf` files anything unrecognised under running.

`isFixedDuration: true` with no usable `fixedDuration` is reported separately, because
the task silently stretches like any other and the flag suggests otherwise.

## Problems

Nothing is dropped quietly. A record either enters state or a problem says why not.

| Code | Severity | Meaning |
| --- | --- | --- |
| `unreadable` | error | the file could not be read |
| `directory-unreadable` | warning | a configured directory could not be listed |
| `duplicate-id` | error | a second record claimed an id already taken |
| `ignored-file` | warning | Markdown sat where records are not read from |
| `unexpected-type` | warning | a file in `projects/` declared it is not a project |
| `unsupported-frontmatter` | warning | YAML outside the subset; the key was left unset |
| `bad-date` | warning | a date field could not be interpreted |
| `bad-number` | warning | a numeric field was unreadable or out of range |
| `bad-boolean` | warning | a boolean field held something else |
| `invalid-status` | warning | a status field held no usable identifier |
| `invalid-enum` | warning | a closed-vocabulary project field held an unsupported value |
| `missing-project` | warning | a reference pointed at no loaded project |

Codes are stable identifiers. The prose in `detail` may change freely; match on `code`.

## Fixtures

Fixtures are real Markdown files, committed as bytes, and the tests read them off disk.
They are not fixtures *of* the format — they are the format.

| Fixture | Covers |
| --- | --- |
| `fixtures/vault-basic` | the preferred layout, explicit ids, a record with no id |
| `fixtures/vault-legacy` | `-Hide/Proxima`, filename ids, flat and `index.md` projects, project-folder content, `type: project` on projects and unrelated `type:` on a task and an event, packed `linkedFolders`, a hand-renamed file with an explicit id |
| `fixtures/vault-duplicates` | colliding ids across both project forms, a declared id colliding with a derived one, a task filed in a subfolder, a reference to a project that does not exist |
| `fixtures/vault-malformed` | out-of-range and unreadable numbers, a boolean written as `yes`, an empty status, dates in prose, an event whose deadline precedes its start, and a nested mapping that would previously have rewritten its record's identity |

`fixtures/vault-duplicates` and `fixtures/vault-malformed` are expected to produce
problems. That is what they are for.
