# The store, the index and git

Read when a merge conflicts in `docs/projects/`, when setting up `.gitattributes`, or when upgrading a tree that still has the old packed store.

## One file per project

`docs/projects/entries/<slug>.json` holds one project each. A packed array made every write rewrite the whole file, so two machines editing unrelated projects still collided on the same bytes, and a JSON array conflict has no semantic merge. One file per project makes unrelated edits disjoint, and a same-project fork conflicts on one small file, which is correct.

The directory also holds a `.gitkeep`. Git cannot track an empty directory, and an emptied store has to survive as an empty store. Without the keeper the directory is absent on the other machine's checkout, which reads as a root where nothing was ever registered rather than one deliberately emptied.

## The index

`INDEX.md` is still rendered and committed, because it makes the list readable on the forge and gtg's `inferParent` reads it to resolve project families. It rewrites wholesale on every operation, so it stays a conflict point. On a conflict, take either side and run any `projects` command, which regenerates it from the store. A rendered file has no meaningful merge, so the conflict is noise and regeneration is the fix.

## The write-guard

The `PreToolUse` hook denies agent edits to `INDEX.md`, to the record files under `entries/`, and to the deleted packed `_projects.json`, and names the verb to use instead. The index is regenerated on every mutating verb, so a hand-edit is lost at the next write. An edit to the packed path is worse, because nothing reads that file at all. Narrative pages are not guarded.

## `.gitattributes`

```
docs/projects/INDEX.md -merge
docs/projects/entries/*.json -text
```

The `-text` line is correctness, not tidiness. A write is skipped when the file's bytes already equal the record's serialisation. Under a `text=auto` rule every record reads as changed after a fresh clone on Windows, so the first mutating verb in that checkout rewrites the whole store instead of one file. Only the first, because that write lands LF and settles the file. One command losing the per-record isolation is enough: that commit is the conflict the sharding exists to prevent.

## The packed store it replaced

`docs/projects/_projects.json` was the packed array. It is deleted as of 1.3.0, along with the self-migration and the fallback that read it. The directory is now the whole store, and an absent directory is a root with no projects rather than a tree waiting to be migrated.

- **To migrate a still-packed tree,** install 1.1.1 to 1.2.0 once and let it shard, then upgrade.
- **To roll back to a pre-1.1.1 plugin,** restore the packed file from git history (`git show <pre-shard-commit>:docs/projects/_projects.json`) and install that plugin. The snapshot is the state at the shard, so rows written after it stay in the directory's own history.
