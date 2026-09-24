# Forge store (optional)

gtg keeps its store in files by default: `docs/handoffs/active/<slug>.json`, `backlog/<slug>.json` and
`current/<slug>.md`, committed to git. A repo can instead point gtg at a Forgejo or Gitea forge, so
every session reads and writes one shared surface through the issue tracker agents already know.
With no forge configured nothing changes. `"store": "files"` selects versioned files in a
dedicated Forgejo repository. Without it, the milestone store below remains available.

## Dedicated file repository

Use this config in the hub's `.gtg/forge.json`:

```json
{ "api": "http://forge.example:3000/api/v1", "repo": "owner/gtg-store", "store": "files", "tokenFile": "${APPDATA}/forgejo-cli/forgejo-cli/data/keys.json" }
```

Each project is one `docs/handoffs/records/<file-id>.json` file containing its slug,
`active` or `backlog` shelf, and current handoff body. A rename changes the slug inside
the same file. Forgejo's Contents API writes each change as a commit and requires the
previous SHA on updates. This prevents a stale client from silently replacing a newer
handoff or splitting it from its metadata. The hub remains the caller's home repo,
so local progress records and portfolio hooks keep their existing paths. The GTG store
repo needs no tracking issues or milestones. `complete` and `remove` delete the record,
with its previous handoffs retained in Git history.

The file store has the same command support as the milestone store, including the same
refused history commands. On an API error during handoff, the body is saved locally at
`docs/handoffs/current/<slug>.md` and the command exits 1.

## Mapping

| gtg | Forge |
|---|---|
| A project (one record) | One **open milestone**. Title = project name. Description = the Next Action line, then the whole record as a fenced `json gtg` block |
| Active vs backlog | `"shelf": "active"` or `"backlog"` inside that block. Both stay open milestones |
| The handoff body | A **comment** on the project's tracking issue. Latest comment = current handoff |
| Tracking issue | One issue in the milestone, labelled `gtg`, created with the milestone. Its number is `"issue"` in the block |
| Tasks | Ordinary issues in the milestone. `resume` lists the open ones |
| complete / remove / supersede | Closes the milestone and the tracking issue, with a one-line comment naming the verb |

A milestone without a `json gtg` block is not a gtg project and is ignored, so hand-made milestones
can share the repo.

## Config

`<root>/.gtg/forge.json`, per consuming repo:

```json
{ "api": "http://forge.example:3000/api/v1", "repo": "owner/name", "tokenFile": "${APPDATA}/forgejo-cli/forgejo-cli/data/keys.json" }
```

Token: `FORGEJO_TOKEN` wins, else `tokenFile` (`${VAR}` expands from the environment). The file may be
the bare token or forgejo-cli's `keys.json`, where the entry for the api's host is used. A config with
no token is an error, never a silent fall back to files.

## How it runs

One `GET /milestones?state=open` (paged) loads every record into memory when a command starts. The
commands edit that snapshot exactly as they edit the file store, through the same `entries()` and
`saveEntries()`. When the command finishes, one flush writes the difference: a new record creates the
milestone and tracking issue, a changed record patches the milestone, a missing one is closed, and a
queued handoff body is posted as a comment. The store abstraction is those two functions plus the flush.

If the forge write fails during `handoff`, the body (read from stdin, so otherwise gone) is written to
`docs/handoffs/current/<slug>.md`, uncommitted, and the command exits 1.

## Commands

| Behaviour | Commands |
|---|---|
| Read and write the forge instead of files | `list`, bare `gtg`, `backlog` (list and park), `handoff`, `resume`, `back`, `active`, `keep`, `complete`, `remove`/`rm`/`prune`, `supersede`, `rename`, `unparent`, the `REVIEW:` line, and the `issues`/`learn` extension listings (they read through `ownEntries`) |
| Refused with a pointer to the forge timeline | `log`, `undo`, `stats`, `report`. They read git history of the file store, which the forge store does not write |
| Unchanged | `help`, `progress` (still files under `docs/handoffs/progress/`), `--wip`, the after-handoff and after-resume hooks (same ctx, `file` is null) |

`resume` does not fast-forward the hub from its git upstream on the forge store: the forge is already
the shared copy.

## Left out on purpose

- No migration command. Moving a file-store project is: create the milestone with its record, create
  the tracking issue, post the current `.md` as the first comment.
- The tracking issue title is set once and not renamed with the project.
- Comments are read in one unpaged call. A project with hundreds of handoffs pays for that on resume.
