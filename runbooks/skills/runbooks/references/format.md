# Runbook format

Five genres share the runbooks folder. Every file declares which it is, and the hooks treat
them differently.

| Type | What it is | How it reaches a session |
|---|---|---|
| `procedure` | A thing you run, in order | Per prompt, from the router, when its purpose matches the task |
| `standard` | A rule you must not break | Per prompt, from the router, when its purpose matches the task |
| `reference` | A lookup table, map or profile | Per prompt, from the router, when its purpose matches the task |
| `residual` | What is wrong on purpose in one code path | Session-start tail, slug only, on a named line |
| `postmortem` | A record of what was tried and why it ended | Session-start tail, slug only, on a named line |

## Pull and push

You go looking for a procedure, because you already know you are about to deploy something. A
standard has to find you, because you break a quoting rule without suspecting a document
covered it. The router does the finding for both. It asks one model call whether each purpose
line applies to the prompt and injects the ones that score 0.8 or higher. It can only match on
the words in the purpose, so put the trigger first.

Residuals and postmortems are reached by a trigger the session cannot miss. You reach a
residual by editing the file it names, and a postmortem by proposing the thing it says was
tried. So they are not routed. The session-start index names them in one line each. Write
their purpose for the reader who opens the file, not for the router.

## The header

Every file opens with this header, fields in this order:

    # <Name>
    **Type:** procedure | standard | reference | residual | postmortem
    **Status:** retired YYYY-MM-DD — what replaced it, or why it died
    **Purpose:** one line, what this is for and when it applies.
    **Run:** the single entry command
    **Verified:** YYYY-MM-DD

`Type` and `Purpose` are required. The others appear only when they apply.

**`Status` is absence-based.** Only retired and dormant files carry it, in one of two forms:

- `**Status:** retired YYYY-MM-DD — why`. The em dash is required. A retired file never routes.
  At the top level of the folder it is named in the session-start tail as "do not re-propose".
- `**Status:** dormant YYYY-MM-DD, why`. A live process that is parked. It never routes and gets
  no tombstone. Delete the line to wake it.

Any other `Status` value is a lint violation.

**`Run`** is for procedures only, and only where one obvious entry command exists.

**`Verified`** records the date the runbook was last checked against reality. Commit dates stop
meaning anything once a sweep has touched every file, so this is the freshness signal.

**`Purpose` must be one physical line.** The parser reads a field to the end of its line and no
further, so a purpose that wraps is silently truncated. Everything past the first line never
reaches the index or the lint. Write it long if it needs to be long, but write it on one line. For
standards and references the lint also fails a purpose over 25 words, because that line is the
question the router asks. How to write one is in `purpose-lines.md`.

**Those five labels are the whole set.** A sixth `**Something:**` in the header block is a
violation, because a field nobody parses is a field that silently does nothing. The header block
ends at the first blank line, so a bold lead-in in the body is ordinary prose and is not caught.

The blank line between `# Title` and the header block is optional. No blank line is canonical,
and both parse the same.

Only the first 800 bytes count as the header. A second `**Purpose:**` further down the body is
ignored.

## The `## Steps` section

Procedures carry `## Steps` with numbered, exact commands and paths. The lint requires an H2
reading exactly `## Steps` somewhere in the file. It does not require that section to hold the
sequence.

So a procedure whose step section has a meaningful name keeps that name as an `###` child under
a `## Steps` parent:

    ## Steps

    ### Verifying a theme by driving the editor directly
    1. ...

Do not overwrite a meaningful heading to satisfy the rule. Nest it.

A retired procedure is a tombstone, not a process, so it needs no `## Steps`.

## Gotchas

All five genres are living documents. When a run hits a new issue, the session that hit it
appends the fix to that file's `## Gotchas (append-only, dated)` section in the same session, as
`- YYYY-MM-DD. Symptom, then the fix.`

## The lint

    node <plugin>/scripts/index.mjs --lint

It reports header violations and exits 1 on any. `README.md` in the runbooks folder is format
doctrine, not a runbook, and is skipped.

Run it after adding a runbook, after retyping one and after editing any header. Those are the
three moments a header can drift, and the drift is invisible from the file itself. A truncated or
missing purpose reads perfectly on the page while contributing nothing to the router.

The lint checks:

- `Type` present and one of the five genres
- `Purpose` present, on one physical line, and 25 words or fewer on a standard or reference
- fields in order, and no field outside the five
- `Status` in the retired or dormant form
- `Run` only on a procedure
- `## Steps` on every live procedure

It also prints advisories that never change the exit code:

- **Split candidates.** Files over 2,000 words. Whether they want splitting is a judgement call.
- **Retired tail price.** How many characters the top-level tombstones add to every session.
- **Missing local paths.** Backticked absolute or `~/` paths a live runbook names that do not
  exist. Fix each one, or reword it as history outside backticks.
- **Changed purposes.** Purpose lines that moved since their last router check, and ones never
  checked. `check.mjs --changed` re-runs only those.

Rules of your own go in `.runbooks/lint/<name>.mjs`. See the plugin README.
