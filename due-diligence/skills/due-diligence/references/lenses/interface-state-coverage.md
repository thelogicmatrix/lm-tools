# interface-state-coverage — Is every state the system can enter actually designed?
> Cites: res_interface-states.md

## Fires on
Tags: `rendered-ui`, `code`, `llm-pipeline`, `pipeline`, `cron`. Any artifact that has states and transitions — a UI, a feature spec, a flow, a long-running process, anything a user can interrupt or return to. Reviews whether the *full state graph* was designed, beyond error-handling (which checks whether code catches exceptions) and operational-completeness (which checks whether the thing runs at all). This lens asks whether the state exists in the design, and what the user sees when the system is in it.

## Attacks

**A. Undesigned states**
- Only the ideal path is specified; everything else labelled "edge case" and deferred. The deliverable shows the success screens and nothing else.
- No empty / first-run / zero-data state, in a design that assumes populated content.
- No loading, partial, or intermediate state on an operation long enough to need one — or a bare spinner standing in for a designed state.
- Defaults inherited rather than chosen: first-launch value, hold-vs-auto-reset, update cadence. Each encodes an assumption about the user; none is neutral.

**B. Re-entry and interruption**
- No account of what the user sees returning mid-process, resuming after interruption, or arriving by an unexpected route (deep link, back navigation, notification, restored session).
- State silently reset on return, or stale state presented as current with no indication of elapsed time.

**C. Errors as non-states**
- An error that names no condition and opens no exit — `Something went wrong` and its variants. **An error is a transition; if it has no path out, it is a dead end.**
- Error text written as a warning label appended to a working interface rather than as the interface at that moment.

**D. Silent failure**
- An inferred, preset or defaulted value that is simply wrong for the user's situation, with nothing indicating the assumption was made.
- Misrecognised or ambiguous input accepted without comment, producing the wrong outcome rather than an error.
- Truncation, capping or a skipped step that is not surfaced (cross-refs agency-preservation).

**E. Cross-boundary and lifecycle**
- Behaviour undefined across process, device or service boundaries: scheduled work lost on restart; a delivery fired for something that no longer exists; a revoked permission meaning work completes with no delivery and no signal.
- Cancel and reset conflated — abandonment and preparation-for-reuse treated as one operation.

**F. Concurrency and channel**
- Multiple simultaneous instances with no differentiation, labelling, ordering rule, or simultaneous-completion behaviour; a list that reorders while the user is tracking it.
- The state machine designed only for the visual channel — no account of how transitions are paced or announced non-visually, or of parallel information forced into a linear channel.

## Evidence of attack (clean-pass proof)
Enumerate the states, don't assert coverage: **list every state the artifact can enter** and mark each designed / undesigned / not-applicable-because. Name the first-run and empty states specifically. Quote each error message and say what condition it names and what exit it offers. State what happens on re-entry mid-process, and on interruption. Name at least one cross-boundary condition you tested (restart, revoked permission, backgrounding, lost connection) and its behaviour. For anything supporting multiple instances, state the ordering and simultaneous-completion rule. **"Handles errors gracefully" is not evidence** — quote the state and its exit. If you could run it, say which paths you deliberately broke and what happened.

## Severity guide
- **blocker**: a reachable state with no designed behaviour that loses the user's work, strands them with no exit, or produces a wrong result silently; an error message that names no condition and offers no path out; scheduled or in-flight work silently lost across a boundary.
- **should-fix**: missing empty / first-run / loading state; re-entry undesigned; cancel and reset conflated; concurrency with no ordering or differentiation rule; a default that encodes an unexamined assumption about the user; state designed only for the visual channel.
- **nit**: an intermediate state that could be more informative; a transition that could be smoother; error copy that is correct but colder than it needs to be.
