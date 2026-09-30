# lib-cli

The shared CLI framework. Each plugin's CLI vendors the files it needs, because an installed plugin cannot import a sibling plugin and must ship whole.

| File | Gives |
|---|---|
| `root.mjs` | `gitTop(cwd)`, the git toplevel with no shell and a 2 s timeout. `hubRoot(envName)`, a storage-root variable else the toplevel |
| `args.mjs` | `parseArgs(argv, { multi, boolean })` and `parseFlags(argv)`, flags with no schema |
| `store.mjs` | `readCollection` and `writeCollection`, a one-file-per-record JSON store with atomic writes. `slugCollision(items)`, the first slug that repeats when case is ignored, else null |
| `git.mjs` | `runGit(args)`, git with an index.lock retry and a timeout. `firstMeaningfulLine(e)` |
| `exit.mjs` | `isMain(import.meta.url)`, junction-safe. `fail(message, code)`, which sets the exit code without exiting |

## Vendoring a file

1. List it in a `.framework.json` in the folder the copy will live in, for example `myplugin/skills/myplugin/lib/.framework.json` holding `{ "files": ["args.mjs", "exit.mjs"] }`.
2. Run `node scripts/sync-lib.mjs` from the repo root and commit the copies with the manifest.
3. Import the copy by its relative path, `./lib/args.mjs`.

## Changing a file

Edit `lib-cli/<file>`, never a vendored copy. Run `node scripts/sync-lib.mjs`, then run the suites of every plugin that vendors it, and commit the canonical file and every copy together. `test/framework.test.mjs` fails on any copy that differs from its canonical file, and on any plugin that imports outside its own folder. The import check reads import specifiers only, so a plugin that runs a sibling plugin's file by a relative path is out of its scope, and issue #126 tracks the one case today (jevmail runs postman.py).

A file joins lib-cli when a second plugin needs it. `forge.mjs` and the progress lock stay in gtg until then.
