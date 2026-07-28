# res_interface-states — The State-Coverage Bar
> Research-backed reference for the Due Diligence interface-state-coverage lens. Whether *every state a system can enter* has been deliberately designed — not just the ideal path. Distinct from res_code-quality's error-handling (whether exceptions are caught in code); this is "does the state exist in the design at all, and what does the user see when the system is in it."

## The core claim

Software is always in motion. It transitions between states, runs in conditions it was not designed for, crosses process boundaries, and fails. **Every one of those conditions produces an experience whether or not anyone designed it.** An undesigned state is not an absent state — it is present as *undefined behaviour*, and in user experience undefined behaviour looks like confusion.

The vocabulary itself causes the defect. Calling something an "edge case" has already decided it comes after the real design work, and in most projects "later" means never. But the system does not experience the distinction: the paused state is not less real than the running state, and the error state is not less present than the success state. **The ideal path is one trajectory through a much larger graph; designing only that trajectory does not simplify the graph, it leaves the rest of it undesigned.**

Generation tools intensify this. A component library, a coherent visual language, and a set of plausible screens can now be produced in minutes — so **the surface arrives fully formed before the structural questions have been asked**, and the gap between what looks finished and what is actually designed is wider and harder to see than ever. Generation fills unspecified states by defaulting: to training data, to whatever the component library does out of the box, to statistically common patterns. Coverage improves; *care* does not.

## What good looks like (the bar)

- **A state map exists, and it precedes the screens.** Not a flow diagram (the ideal path with branches) but the full graph, including states with no natural place in a linear sequence. The design question *what can this system be* is answered before *what should this look like*. [Harel, Statecharts; Stately/XState practice]
- **Every state is named and reachable in the design.** Idle, loading, partial, empty, populated, running, paused, elapsed, error, offline, unauthorised, expired, cancelled — each has a considered form, not a default rendering. [The UI Stack; The Nine States of Design]
- **Error states are designed as primary UI, not as labels appended to a working interface.** An error is a *transition*: it must name the condition and open at least one path out. A message that identifies nothing and offers no exit is a state with no exit — the worst possible outcome, and the most common. [NN/g error-message guidance]
- **Empty and first-run states are designed.** First launch with no prior session, no data, no history. Every blank screen is already a decision about what the user is assumed to know on arrival.
- **Re-entry is a first-class design object.** What the user sees returning mid-session, resuming after interruption, or arriving at a screen by an unexpected route (deep link, back button, notification, restored tab). These are frequently the *first* thing a real user encounters and are almost never specified. [Basecamp, Getting Real — three-state solution]
- **Cross-boundary states are covered.** Anything scheduled with, delegated to, or dependent on another process — the OS, a notification service, a background worker, a device reboot, a revoked permission, a changed system clock. The design of the in-app control and the design of the out-of-app behaviour are not separable.
- **Concurrency and multiplicity are addressed.** One instance fills the screen naturally; two require differentiation; three require a list. Layout under concurrency is a structural decision about representing parallel processes, not a styling choice. Simultaneous completion, ordering, and reordering-while-watched are named.
- **Every state renders correctly through every output channel.** The same state machine through a screen reader, a small viewport, or an audio channel is the same design question asked again — a visual transition that is peripheral and glanceable becomes a linear interruption in audio. These are not accommodations bolted on afterwards.
- **Defaults are stated and justified.** Empty field vs suggested value vs last-used; hold-until-dismissed vs auto-reset; update cadence. Each encodes a theory about the user, and none is neutral.

## Common defects (what to attack)

- **Only the ideal path is specified.** Everything else labelled "edge case" and deferred; the deliverable shows the success screens and nothing else.
- **`Something went wrong`** — or any error that names no condition and offers no next action.
- **No empty / first-run / zero-data state.** The design assumes populated content that a real first user will not have.
- **No loading or partial state**, or a spinner standing in for a designed intermediate state on an operation long enough to need one.
- **Re-entry undesigned.** No account of what the user sees on return mid-process; state silently reset, or stale state presented as current with no indication of elapsed time.
- **Cross-boundary failure unhandled**: a scheduled action fires for something that no longer exists (ghost notification); scheduled work is silently lost on restart; a revoked permission means the work completes with no delivery and no signal that it happened.
- **Silent failure modes.** A preset or inferred value that is simply wrong for the user's situation with no indication the assumption was made; misrecognised input that produces no error at all, just the wrong outcome.
- **Cancel and reset conflated.** Abandonment and preparation-for-reuse treated as one operation — confusing at exactly the moment the user's intent is clearest.
- **Concurrency ignored.** No differentiation, labelling, ordering rule, or simultaneous-completion behaviour for multiple instances; a list that reorders itself while the user is trying to track it.
- **State only designed for the visual channel.** No account of how transitions are announced or paced for a screen reader; parallel information poured into a linear channel.
- **Generated UI accepted because it looks finished.** Plausible screens covering the happy path, with the structural state questions never asked.

## Quick-reference checklist

- [ ] A state map (not a flow diagram) exists and preceded the screens
- [ ] Empty, first-run, loading, partial and populated states are all designed
- [ ] Every error state names its condition and opens at least one exit
- [ ] Re-entry / resume-after-interruption / arrival-by-unexpected-route is specified
- [ ] Cross-boundary behaviour covered (OS, scheduler, reboot, revoked permission, background)
- [ ] Silent-failure paths identified — where a wrong result is produced with no signal
- [ ] Cancel vs reset (and equivalents) are distinct operations
- [ ] Concurrent/multiple instances: differentiation, ordering, simultaneous completion
- [ ] Each state checked through non-visual and small-viewport rendering
- [ ] Defaults named and justified rather than inherited

## The productive test

The cheapest way to find undesigned states is to **deliberately leave the path** — not to find bugs, but to find states that exist without a design. Pause halfway. Enter nothing. Enter the wrong thing. Switch away and come back. Force completion while looking elsewhere. Kill and restart. Revoke a permission mid-flow. **Every blank, frozen, or undefined response is a state the system can enter that nobody shaped.**

## Sources

- [Harel, "Statecharts: A Visual Formalism for Complex Systems" (1987)](https://dubroy.com/refs/Statecharts_a_visual_formalism_for_complex_systems.pdf) — the foundational formalism for describing the full state space of a reactive system, including hierarchy and concurrency.
- [State machines in user interfaces (24 ways)](https://24ways.org/2018/state-machines-in-user-interfaces/) — applying statechart thinking to UI; enumerating states before rendering them.
- [Stately / XState](https://stately.ai) — practical tooling for modelling and visualising UI state machines.
- [Scott Hurff — The UI Stack](https://www.scotthurff.com/posts/why-your-user-interface-is-awkward-youre-ignoring-the-ui-stack/) — the five states (blank, loading, partial, error, ideal) every screen must account for.
- [The Nine States of Design](https://medium.com/swlh/the-nine-states-of-design-5bfe9b3d6d85) — an expanded enumeration used as a design checklist.
- [NN/g — Edge cases](https://www.nngroup.com/articles/edge-cases/) — evidence that edge cases fall through not from lack of skill but because they are scenarios teams would rather not consider.
- [Basecamp, Getting Real — The Three-State Solution](https://basecamp.com/gettingreal/09.3-three-state-solution) — designing the regular, blank and error states as a matter of course.
