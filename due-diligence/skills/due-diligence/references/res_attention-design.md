# res_attention-design — The Interruption & Alarm Bar
> Research-backed reference for the Due Diligence attention-cost lens. Whether a system's outbound signals — notifications, alerts, emails, digests, badges, escalations — are rationed against the attention they consume. Distinct from res_operations' observability (signals *for operators*, about system health); this is about anything that interrupts a human and asks for their attention.

## The core discipline

Process-control engineering solved this problem in the 1990s after fatal industrial accidents, and the resulting standard is directly portable to software. Its central move is not to rank alerts by priority but to **refuse to let most signals be alerts at all.**

One question is asked of every signal a system wants to raise:

> **Does this require the recipient to do something?**

Not *might they like to know*. **An alarm is defined by the action it requires.** A signal that needs nothing from the recipient is not a lower-priority alarm — it is a *different kind of thing*: an alert, a status reading, a log entry. It does not go to the interrupting channel at all. It goes to **a quiet surface the user checks when ready.**

Asking that question of every signal and recording the answer is called **rationalisation**. It is tedious, and it is the whole discipline. The reference standard sets a target for a normally-running plant of **no more than one alarm every ten minutes**.

The vocabulary earned the hard way, and its software equivalents:

| Term | Meaning | Software form |
|---|---|---|
| Alarm flood | More signals than a person can act on | The queue after any absence |
| Nuisance alarm | Fires without needing anything, training the user to ignore it | Engagement notifications manufactured on purpose |
| Standing alarm | On so long it has become wallpaper | A badge count nobody will ever clear |
| Shelving | Setting a signal aside deliberately, on the record, for a set time | Snooze; scheduled summary |

## Why fixes arrive as settings screens

The structural insight, and the thing worth testing any notification design against: **an alarm channel can only be rationalised by an authority whose interests match the recipient's.**

A plant can fix its alarms because one party owns the system and wants what the operator wants. A hospital ward largely cannot, because dozens of vendors' devices on their own defaults sound into one corridor with nobody able to decide what may make noise. **A general-purpose notification channel is the ward case:** the platform runs the channel but does not own the senders, and each sender's interest is to pull the user back. So the platform can only hand out controls — homework — rather than change the behaviour.

The diagnostic question for any system that notifies: **who owns this channel, and do they want what the recipient wants?** If the answer is no, expect the fix to arrive as a preference the user must find, and expect it not to work.

## On blame

Signal detection theory settles the "users just ignore alerts" objection: **people calibrate to reliability.** An alert that is usually not worth acting on trains everyone near it to respond as rarely as it is right. Someone silencing a channel is not failing the system — they are reading it correctly. **Alert fatigue is a credibility problem in the machine, not a discipline problem in the human.** A system that blames the recipient for ignoring it has misdiagnosed its own defect.

## What good looks like (the bar)

- **Admission control at send time.** Every signal is declared with the action it requires, or it routes by default to the quiet surface. The test is applied at the moment of sending, not by the recipient afterwards.
- **A second destination actually exists.** There is a non-interrupting surface — a log, a digest, a status view, an activity feed — where non-actionable signals go and can be found later. Most systems never build it, which is why everything ends up in the one channel.
- **Rate limits per sender.** A cap on interruption frequency, sized for the medium. Bursts are collapsed rather than delivered individually.
- **Earned interrupt rights.** A sender or category whose signals go persistently unread loses the ability to interrupt — reliability calibration performed by the system instead of inside the recipient's head.
- **Batching over silence.** The strongest field evidence favours scheduled summaries: batching notifications a few times a day improved mood, attention and sense of control, hourly batching did little, and **switching notifications off entirely made things worse**, raising anxiety and fear of missing out. Design the digest, not just the off switch. [Fitz et al., 2019]
- **Defaults carry the design, not settings screens.** Default state moves behaviour by tens of points where preferences move it barely at all. A feature that only helps users who find and configure it has not shipped.
- **Severity is scarce and means something.** If most signals are high priority, none is. Priority levels are defined by required response, and the distribution is checked rather than assumed.
- **The interruption is worth more than what it costs.** Herbert Simon's formulation is the general bar: an information system is only worth having if **it saves more attention than it consumes.** Every interruption is a withdrawal that has to justify itself.
- **The right interruption method is chosen deliberately.** Four exist — interrupt immediately, negotiate (announce and let the user pick the moment), mediate (an agent decides), or schedule (hold and deliver in batches). Immediate is the default in practice and is rarely the correct one. [McFarlane, 1997]
- **Peripheral delivery is considered before central delivery.** Calm-technology practice: information can be *re-encoded* to sit at the edge of attention rather than demanding the centre. Not everything that must be conveyed must interrupt. [Weiser & Seely Brown]
- **Quiet hours, batching windows and escalation paths are explicit** for anything operational, and a genuine emergency has a distinguishable path that routine traffic cannot occupy.

## Common defects (what to attack)

- **One channel for everything.** Actionable and informational signals arrive in the same place, drawn the same way, with the same sound — so the recipient must triage what the system should have.
- **No quiet destination.** Non-actionable output has nowhere to go, so it either interrupts or is discarded.
- **Signals that require no action** presented as if they do — completion notices nobody acts on, weekly summaries, "someone did a thing" engagement prompts.
- **Everything high priority.** Severity assigned by the sender's interest rather than by required response.
- **No rate limit.** A loop, retry, or fan-out can emit unbounded notifications; a burst arrives as N separate interruptions.
- **Unbounded standing state.** A badge or counter that accumulates permanently and can never reach zero — a guilt pile with a number on it.
- **Blaming the recipient.** Alert fatigue treated as user error rather than as evidence the channel has lost credibility.
- **The off switch as the only control.** No batching, no digest, no per-category granularity — so the realistic user choice is all or nothing, and the evidence says all-or-nothing is worse than batching.
- **Help hidden behind configuration.** The mitigating feature exists but is off by default and buried, so it protects only the users who least needed protecting.
- **Notification designed separately from the thing it reports.** Scheduling, cancellation, and reboot behaviour of the alert treated as an afterthought rather than as part of the feature (cross-refs interface-state-coverage).
- **No escalation distinction.** A real failure looks exactly like routine traffic, so it is missed inside the flow.

## Quick-reference checklist

- [ ] Every signal type has been asked "does this require action?" and the answer recorded
- [ ] A non-interrupting destination exists for signals that need no action
- [ ] Per-sender / per-category rate limits exist; bursts collapse rather than fan out
- [ ] Unread signals reduce a sender's future ability to interrupt
- [ ] Batched digests are offered, not just an off switch
- [ ] The helpful behaviour is the *default*, not a setting
- [ ] Priority levels are defined by required response and their distribution checked
- [ ] Interruption method (immediate / negotiated / mediated / scheduled) chosen deliberately
- [ ] Peripheral or ambient delivery considered before interrupting delivery
- [ ] Genuine emergencies have a path routine traffic cannot occupy
- [ ] Standing counters can actually reach zero

## Sources

- [EEMUA 191 — Alarm systems: a guide to design, management and procurement](https://www.eemua.org/products/publications/print/eemua-publication-191) — the industry standard behind rationalisation, the alarm/alert distinction, shelving, and the one-per-ten-minutes target; the two governing international alarm standards are aligned to it.
- [HSE — Better alarm handling (CHIS6)](https://www.hse.gov.uk/pubns/chis6.pdf) — regulator guidance on alarm floods, nuisance and standing alarms, and operator loading.
- [Texaco Milford Haven refinery explosion report (1994)](https://www.jesip.org.uk/wp-content/uploads/2022/03/Texaco-Refinery-Explosion.pdf) — the originating case: 275 alarms in the final 11 minutes, ~2,040 configured and most set high priority. When everything is urgent, nothing is.
- [Joint Commission Sentinel Event Alert 50 — Medical device alarm safety (2013)](https://www.jointcommission.org/en-us/knowledge-library/newsletters/sentinel-event-alert/issue-50) — the multi-vendor case, and the estimate that 85–99% of ward alarm signals require no clinical action.
- [Sorkin, "Why are people turning off our alarms?" (1988)](https://doi.org/10.1121/1.397232) — signal detection theory: recipients calibrate their response to an alarm's reliability.
- [Simon, "Designing Organizations for an Information-Rich World" (1971)](https://gwern.net/doc/design/1971-simon.pdf) — a wealth of information creates a poverty of attention; the save-more-than-it-costs test.
- [McFarlane, "Coordinating the Interruption of People in Human-Computer Interaction" (1997)](https://www.interruptions.net/literature/McFarlane-Interact99-Coordinating.pdf) — the four interruption methods and their experimental comparison.
- [Horvitz, "Principles of Mixed-Initiative User Interfaces" (1999)](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/) — weighing message value against the cost of interrupting; attention as a budget.
- [Fitz et al., "Batching smartphone notifications can improve well-being" (2019)](https://static1.squarespace.com/static/57a40c19414fb54f51f8095f/t/614a55faa7b89e25f4e48ad1/1632261627146/2019+Fitz+Batching.pdf) — field experiment (n=237): three-times-daily batching improved mood, attention and control; hourly did little; switching off entirely was worse than batching.
- [Weiser & Seely Brown — Calm technology](https://calmtech.com/papers) — moving information between the periphery and the centre of attention rather than always demanding the centre.
