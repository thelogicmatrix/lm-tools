# Persistent task progress

Use this for an ongoing multi-step project, including native subagent work. `gtg.mjs` means the installed skill's CLI. Set `GTG_HUB` explicitly when using a shared hub. These commands do not pause or depart; bare `gtg` keeps its existing meaning.

## Start and inspect

A slug follows one line of work under its named project across sessions. Maintain it automatically at meaningful task transitions and before yielding after substantive work, without waiting for a departure request. Batch changes using existing updates; do not update per tool call or reread unchanged state. On any fresh session, use the known slug or list to find the current work, then run `progress show <slug> --json` once before reconstructing or continuing tasks. Continue its next action without requiring a parked handoff.

Mutations attribute the participating session from explicit `GTG_SESSION_ID`, then native `CODEX_THREAD_ID`/`CODEX_SESSION_ID` (and Claude's session ID). Session history is recorded participation, not worker liveness. The record is current only as of its timestamp; a crash can precede the next checkpoint. No background model calls are involved.

Link a stable project slug to its implementation plan. The plan owns requirements; this record owns execution state. Initialise once, with the plan's stable task IDs and short purposes:

```powershell
$env:GTG_HUB = 'C:/path/to/hub'
'[{"id":"1","purpose":"Implement progress storage"},{"id":"2","purpose":"Review integration"}]' | node path/to/gtg.mjs progress init example --project 'Example' --plan 'C:/path/to/plan.md' --stage development --next-action 'Implement task 1'
node path/to/gtg.mjs progress show example
node path/to/gtg.mjs progress show example --json
node path/to/gtg.mjs progress list
```

An empty task array is valid. The CLI refuses reinitialising an existing record. Read it instead. `show` and `list` are read-only: they do not sync, consume or shelve handoffs. Use `list` when finding a project, then read the matching slug; clarify only an ambiguous match. Relay persisted status directly; the CLI calculates counts. A worker is running only when a current native-agent snapshot confirms that. Otherwise describe it as last recorded implementing, with liveness not checked.

## Record a transition

Read the current revision, then pass it to the update. A stale revision fails without changing state; reread and reconcile the actual changes before retrying.

```powershell
node path/to/gtg.mjs progress update example 1 --expected-revision 1 --status implementing --worker /root/progress_builder --role implementer --model gpt-5.6-sol --effort high
node path/to/gtg.mjs progress update example 1 --expected-revision 2 --status reviewing --evidence 'Commit abc123; focused tests passed; awaiting independent review'
node path/to/gtg.mjs progress update example 1 --expected-revision 3 --status done --evidence 'Commit abc123; focused tests and independent review passed'
node path/to/gtg.mjs progress update example --expected-revision 4 --next-action 'Review task 2'
```

The revisions above illustrate a sequence; read the actual revision each time. Supported states are `pending`, `implementing`, `reviewing`, `blocked`, `done`, and `skipped`. Done requires evidence. Blocked or skipped work needs an explanatory note. Reopening done or skipped work needs a note and reduces the accepted count. Keep review open until the required findings are resolved. A worker returning successfully is not itself task acceptance.

Only the orchestrator mutates progress. Workers return changed files, checks, commit and blockers; the orchestrator records the observed result. `--worker` stores the actual ID returned by the native dispatch tool. On review, it can identify the reviewer. Put the parent session/task ID in the note or evidence to disambiguate relative worker names across sessions. Recorded worker IDs are historical references, not a live process listing.

When the plan gains work, append new task definitions without resetting accepted tasks:

```powershell
'[{"id":"3","purpose":"Verify cold resume"}]' | node path/to/gtg.mjs progress add example --expected-revision 5
```

Reconcile obsolete tasks as skipped with a reason. Explain a changed total in the next user update. Keep task IDs stable.

## Handoff and resume

After resume, run `progress show <slug> --json` before reconstructing tasks or redispatching workers. The human summary omits pending/done/skipped task details; use the full current record for stable IDs, states, evidence and worker references, then reconcile any explicit handoff list against it.

The progress record lives in `docs/handoffs/progress/<slug>.json`. A matching normal handoff includes progress automatically. An explicit `## Task list` supplied in the handoff is preserved, never replaced or duplicated; progress appears separately. On resume, current progress is shown and remains on disk after the handoff entry is consumed. Its revision supersedes an older embedded progress snapshot. If an explicit task list disagrees with current progress, reconcile the difference against the plan and evidence rather than silently replacing either.

Use `progress show` to inspect a running project without consuming a handoff. Use normal `resume` when actually picking up parked work. After resume, reconcile historical workers with the current native agent inventory; retain verified completed work and redispatch only unresolved work if the old worker is gone.

Progress mutations commit the one project record through GTG's existing commit helper. Follow the CLI's commit result and normal scoped commit rules; a file existing on disk is not proof it has been committed. Avoid storing credentials, full transcripts or reasoning traces.

## Human updates

At a meaningful transition, relay the CLI's count and add one sentence about the result or blocker. For example:

> Development · 4/9 tasks complete · Task 5 in review
>
> The storage task passed its checks and review. The reviewer is checking the resume path next; no decision is needed from you.

Report spawn failures and review failures explicitly. During a long operation, report what remains active and what depends on it. Progress is task state, not a percentage guessed from time elapsed.
