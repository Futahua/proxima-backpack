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

### `type:` in frontmatter

The plugin marked project files with `type: project`. That marker is honoured, but it
is not what discovery runs on. Its only remaining power is to **veto**:

- absent, or matching the directory (`project` / `task` / `event`) → read normally;
- any other value → not read as a record, reported as `unexpected-type`.

So a note the creator left in the projects directory can opt out by saying what it is,
and every legacy file that carries `type: project` keeps working unchanged.

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

## Problems

Nothing is dropped quietly. A record either enters state or a problem says why not.

| Code | Severity | Meaning |
| --- | --- | --- |
| `unreadable` | error | the file could not be read |
| `directory-unreadable` | warning | a configured directory could not be listed |
| `duplicate-id` | error | a second record claimed an id already taken |
| `ignored-file` | warning | Markdown sat where records are not read from |
| `unexpected-type` | warning | frontmatter vetoed the directory's reading |
| `bad-date` | warning | a date field could not be interpreted |
| `missing-project` | warning | a reference pointed at no loaded project |

Codes are stable identifiers. The prose in `detail` may change freely; match on `code`.

## Fixtures

Fixtures are real Markdown files, committed as bytes, and the tests read them off disk.
They are not fixtures *of* the format — they are the format.

| Fixture | Covers |
| --- | --- |
| `fixtures/vault-basic` | the preferred layout, explicit ids, a record with no id |
| `fixtures/vault-legacy` | `-Hide/Proxima`, filename ids, flat and `index.md` projects, project-folder content, legacy `type:` and packed `linkedFolders`, a hand-renamed file with an explicit id |
| `fixtures/vault-duplicates` | colliding ids across both project forms, a declared id colliding with a derived one, a task filed in a subfolder, a reference to a project that does not exist |

`fixtures/vault-duplicates` is expected to produce errors. That is what it is for.
