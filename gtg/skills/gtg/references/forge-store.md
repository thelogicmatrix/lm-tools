# Forge store (optional)

gtg keeps its store in files by default: `docs/handoffs/active/<slug>.json`, `backlog/<slug>.json` and
`current/<slug>.md`, committed to git. A repo can instead point gtg at a dedicated Forgejo or Gitea
repository, so every session reads and writes one shared copy. With no forge configured nothing
changes.

## Config

`<root>/.gtg/forge.json`, per consuming repo:

```json
{ "api": "http://forge.example:3000/api/v1", "repo": "owner/gtg-store", "store": "files", "tokenFile": "${APPDATA}/forgejo-cli/forgejo-cli/data/keys.json" }
```

`"store": "files"` is required. The earlier milestone store (a project as a milestone, handoffs as
issue comments) was removed on 2026-09-29, and a config without the key is refused rather than
read as something else.

Token: `FORGEJO_TOKEN` wins, else `tokenFile` (`${VAR}` expands from the environment). The file may be
the bare token or forgejo-cli's `keys.json`, where the entry for the api's host is used. A config with
no token is an error, never a silent fall back to files.

## Records

Each project is one `docs/handoffs/records/<file-id>.json` file containing its slug,
`active` or `backlog` shelf, and current handoff body. A rename changes the slug inside
the same file. Forgejo's Contents API writes each change as a commit and requires the
previous SHA on updates. This prevents a stale client from silently replacing a newer
handoff or splitting it from its metadata. Reads take the git tree at `HEAD` and the record
blobs in one batch (`GET git/blobs?shas=`, one GET per blob on a server without it). The blob sha
is the one the next write sends. The Contents API directory listing is only the fallback, for a
truncated tree or a repo with no commit yet. The hub remains the caller's home repo,
so local progress records and portfolio hooks keep their existing paths. `complete` and `remove`
delete the record, with its previous handoffs retained in Git history.

## How it runs

Every record loads into memory when a command starts. The commands edit that snapshot exactly as
they edit the file store, through the same `entries()` and `saveEntries()`. When the command
finishes, one flush writes the difference: a new record is created, a changed one is updated with
its previous sha, and a missing one is deleted.

A write is never resent blind, because one whose answer was lost may have landed. When the answer
is lost (a timeout, a dropped connection, a 5xx) or the sha is refused (409, 422), gtg reads the
record back. If it holds what gtg meant to write, the write landed. If it is unchanged, a lost
write is sent once more. If another session changed it, gtg re-applies its own edit on top once:
fields only this command changed take its values, the rest keep theirs, and the later `updated`
wins. A field both sides changed, or a second change during the re-apply, is an error naming the
record, and nothing of theirs is overwritten. A DELETE of a record already gone is success, and a
DELETE of one changed since the read is refused.

If the forge write fails during `handoff`, the body (read from stdin, so otherwise gone) is written to
`docs/handoffs/current/<slug>.md`, uncommitted, and the command exits 1.

## Commands

| Behaviour | Commands |
|---|---|
| Read and write the forge instead of files | `list`, bare `gtg`, `backlog` (list and park), `handoff`, `resume`, `back`, `active`, `keep`, `complete`, `remove`/`rm`/`prune`, `supersede`, `rename`, `unparent`, the `REVIEW:` line, and the `issues`/`learn` extension listings (they read through `ownEntries`) |
| Refused with a pointer to the store repo's history | `log`, `undo`, `stats`, `report`. They read git history of the file store, which the forge store does not write |
| Unchanged | `help`, `progress` (still files under `docs/handoffs/progress/`), `--wip`, the after-handoff and after-resume hooks (same ctx, `file` is null) |

`resume` does not fast-forward the hub from its git upstream on the forge store: the forge is already
the shared copy.
