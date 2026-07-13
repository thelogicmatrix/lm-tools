# res_operations — The Operational-Safety Bar
> Research-backed reference for the Due Diligence rollback-blast-radius and compliance-policy (ops portion) lenses.

## What good looks like (the bar)

**Release engineering discipline** (Google SRE book, ch.8 "Release Engineering"). Google's release process rests on four principles: **self-service** (teams own and automate their own releases rather than a central gatekeeper doing it by hand), **high velocity** (frequent small releases — fewer changes between versions makes each one easier to test and to blame-assign when it breaks), **hermetic, reproducible builds** (same revision + same build tool version = byte-identical output on any machine, so a bad build is never "works on my machine"), and **enforcement of policy** (source changes, release creation, and deployment are gated operations with defined approvers — not ad hoc). https://sre.google/sre-book/release-engineering/

**Progressive rollout, not a single cutover.** Never ship to 100% of traffic/users in one step. The three standard patterns, in order of infra cost vs. rollback speed:
- **Rolling deployment** — replace instances in batches behind a load balancer; cheap (no duplicate infra) but rollback = another rollout, and it's slower because you're waiting on health checks per batch.
- **Blue-green** — two full identical environments; new version goes live in "green" while "blue" idles as a hot standby, cutover is a router/DNS switch. Rollback is near-instant (switch the router back) and — critically — the fault environment stays *up but silent*, so you can debug it live instead of destroying evidence by redeploying over it. Cost: double the infra during the switch window. (Fowler, https://martinfowler.com/bliki/BlueGreenDeployment.html; AWS whitepaper, https://docs.aws.amazon.com/whitepapers/latest/blue-green-deployments/introduction.html)
- **Canary** — release to a small, real slice of production first, compare against a same-shaped baseline (not an absolute threshold), then ramp. Google's SRE Workbook ch.16 rule: run **one canary at a time** (concurrent canaries contaminate the signal and multiply the states you have to reason about); size and duration must scale with deploy cadence — a service deploying 20×/day needs a canary lasting minutes, one deploying weekly can afford hours; evaluate against the same time-of-day/load profile the full rollout will see, since performance defects often only show under peak load. https://sre.google/workbook/canarying-releases/

**Blast-radius limiting is a design property, not a hope.** Progressive delivery (canary %, feature flags, cell/shard-based architecture) exists specifically so one bad change affects a bounded, known subset of users/infra, not everyone. AWS's own guidance for continuous deployment explicitly shards rollout by "internal shards to further limit the scope of potential impact from a failed production deployment." (https://octopus.com/devops/software-deployments/progressive-delivery/; AWS cell-based architecture guidance)

**Reversibility is decided before the deploy, not during the incident.** A rollback path must exist and be *tested*, not assumed. The gate to ask: "if this breaks in production at 3am, what's the exact command/switch to undo it, and has anyone run that command since the code was written?" Irreversible or hard-to-reverse changes (schema drops, deleted data, one-way data transforms, third-party API calls with side effects) need a backup or dual-write safety net taken *before* the change executes, not after it fails.

**Database migrations follow expand–contract.** Never couple "add the new thing" and "remove the old thing" in the same deploy. Expand (add new column/table, dual-write both), migrate/backfill data, cut reads over, verify, *only then* contract (drop the old column/table) — as a separate, later, easily-skippable step. This keeps every migration backward-compatible with the previous app version, which is what makes app-level rollback possible without also needing a database rollback. Destructive DDL (`DROP COLUMN`, `DROP TABLE`, `TRUNCATE`) needs an explicit, verified backup/snapshot immediately before it runs, independent of the general backup cadence.

**Change management basics**: staged environments (dev → staging → canary → full prod), a named approver/gate for prod deploys, monitoring and alert thresholds defined *before* rollout starts (not "we'll watch the dashboards"), a written rollback procedure attached to the change (not tribal knowledge), and avoidance of high-risk deploy windows (Friday evening, peak traffic, no on-call coverage).

**Observability — can you tell it's working, and know first when it isn't?** Three telemetry pillars: **logs** (structured, queryable, correlatable by request/trace id; no secrets/PII per the security bar), **metrics** (aggregated time-series), and **traces** (request flow across services). Watch the **four golden signals** — latency, traffic, errors, saturation (Google SRE) — or their request/resource forms (RED: Rate/Errors/Duration for services; USE: Utilization/Saturation/Errors for resources). https://sre.google/sre-book/monitoring-distributed-systems/

**Alert on symptoms, not causes — and only on the actionable.** An alert must map to user-facing impact (SLO burn), be something a human can act on, and not add noise: alert fatigue from low-value pages is itself a reliability risk (real signals get ignored). **Define an SLI + SLO before claiming "reliable"** — e.g. "99% of requests < 300ms" turns health into a measurable question; error budgets make the reliability-vs-velocity trade-off explicit. https://sre.google/workbook/implementing-slos/ Health must be externally checkable: health/readiness endpoint, a dashboard, and log/metric retention long enough to debug an incident after it happens.

**Backup & recovery — a backup you haven't restored is a hope, not a backup.** Follow **3-2-1**: at least 3 copies, on ≥2 media/locations, ≥1 off-site. Define **RPO** (recovery point objective — max acceptable data loss, which sets backup frequency) and **RTO** (recovery time objective — max acceptable downtime), then confirm the actual cadence and restore speed meet them. **Test-restore on a schedule** — GitLab lost ~300GB because 4 of 5 backup/replication mechanisms silently weren't working, discovered only after the primary was deleted. **Verify each backup before pruning old ones** — a job that prunes on a schedule but only *creates* a new backup on success can leave you with a shrinking chain (or a verify-failure ballooning storage as nothing prunes) — the retention trap. Retention policy is explicit and monitored, not unbounded growth or silent shrinkage.

## Common defects (what to attack)
- Irreversible change with no backup taken immediately before it runs (schema drop, data delete, destructive migration, one-way transform).
- Unbounded blast radius: change ships to 100% of traffic/users/regions at once with no canary, no percentage ramp, no cell/shard boundary.
- No rollback path defined, or a rollback path that exists on paper but has never been executed/tested.
- Destructive migration bundled in the same deploy as the code that stops using the old schema — breaks backward compatibility, so app rollback can't happen without a separate DB rollback.
- No canary/staged rollout — straight-to-prod cutover with no comparison against a baseline population.
- Concurrent canaries or ramping stages running simultaneously (signal contamination, can't tell which change caused what).
- Partial/inconsistent rollout with no verification that every node received the update — the Knight Capital failure mode: one of eight servers didn't get the new build, a dead code path reactivated, and $440M was lost in 45 minutes before anyone identified — let alone executed — a rollback. (SEC order: https://www.sec.gov/files/litigation/admin/2013/34-70694.pdf)
- Backup/restore procedure that has never been test-restored — GitLab's Jan 2017 incident lost ~300GB of production data because 4 of 5 backup/replication mechanisms turned out not to be working, discovered only after the primary database was deleted. (https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/)
- Evaluating canary/rollout health against an absolute pass/fail threshold instead of a same-shaped baseline comparison (masks regressions that are real but below an arbitrary bar).
- No monitoring/alerting wired up *before* the rollout starts; watching dashboards manually instead of automated abort criteria.
- Deploying at peak load or in a narrow window with no on-call/rollback owner present.
- No metrics on the golden signals (latency/traffic/errors/saturation) — you'd learn of an outage from users, not instruments.
- Logs unstructured or uncorrelatable (no request/trace id), or carrying secrets/PII (cross-ref security bar).
- Alerting absent, or so noisy it's ignored (alert fatigue); alerts fire on internal causes rather than user-facing symptoms.
- No SLI/SLO — "reliable" asserted with nothing measured; no error budget to reason about.
- No health/readiness check, or retention too short to debug an incident after the fact.
- Backups running but never test-restored — recoverability unknown until a real incident proves it false.
- No RPO/RTO defined — no target for acceptable data loss/downtime, so "we have backups" is unfalsifiable.
- Single copy / single location / no off-site (3-2-1 violated) — one failure or ransomware event loses everything.
- Retention that prunes before verifying the new backup, grows unbounded, or silently shrinks the chain on repeated failure.

## Quick-reference checklist
- [ ] Rollback path exists, is documented, and has been executed at least once (staging or a prior release)
- [ ] Change ramps progressively (canary % / rolling batch / blue-green) — no single 100% cutover
- [ ] Only one canary/rollout stage in flight at a time
- [ ] Canary/rollout evaluated against a baseline comparison, not an absolute static threshold
- [ ] Destructive DB operations (DROP, TRUNCATE, irreversible transform) have a verified backup taken immediately prior
- [ ] Migration follows expand-contract: additive change ships and bakes before any removal/contract step
- [ ] Schema change stays backward-compatible with the previous app version (rollback doesn't require a DB rollback)
- [ ] Blast radius is bounded by design (cell/shard/flag/percentage), not by luck
- [ ] Monitoring + abort criteria are defined and wired up before rollout starts, not improvised during it
- [ ] Deploy avoids high-risk windows (no on-call coverage, peak load, right before a freeze)
- [ ] Backup/restore procedure has been test-restored at least once, not just "backups are running"
- [ ] Approval/gate exists for production changes and destructive migrations specifically
- [ ] Golden signals (latency, traffic, errors, saturation) measured and visible on a dashboard
- [ ] Logs structured, correlatable (trace/request id), PII-free; retention long enough to debug post-incident
- [ ] Alerts fire on actionable user-facing symptoms, not noise or internal causes
- [ ] At least one SLI with a target (SLO) defines "healthy"; a health/readiness endpoint exists
- [ ] Backups follow 3-2-1 (≥3 copies, ≥2 locations, ≥1 off-site) and meet a defined RPO/RTO
- [ ] Backups are test-restored on a schedule; retention prunes only verified backups and is monitored

## Sources
- [Google SRE Book — Release Engineering (ch.8)](https://sre.google/sre-book/release-engineering/) — canonical: self-service, high velocity, hermetic builds, policy enforcement
- [Google SRE Workbook — Canarying Releases (ch.16)](https://sre.google/workbook/canarying-releases/) — canary sizing/duration, single-canary rule, baseline vs. absolute-threshold evaluation
- [Martin Fowler — BlueGreenDeployment](https://martinfowler.com/bliki/BlueGreenDeployment.html) — canonical definition, router-switch rollback, DR-testing side benefit
- [AWS Whitepaper — Blue/Green Deployments](https://docs.aws.amazon.com/whitepapers/latest/blue-green-deployments/introduction.html) — why redeploy-to-rollback is slow/unsafe vs. traffic-shift rollback
- [Octopus Deploy — Progressive Delivery](https://octopus.com/devops/software-deployments/progressive-delivery/) — blast-radius limiting via staged exposure
- [pgroll — The three levels of a database rollback strategy](https://pgroll.com/blog/levels-of-a-database-rollback-strategy) — expand-contract pattern for reversible migrations
- [SEC — Knight Capital Americas LLC order](https://www.sec.gov/files/litigation/admin/2013/34-70694.pdf) — real-world cost of unverified partial rollout + no rollback: $440M in 45 minutes
- [GitLab — Postmortem of database outage of January 31, 2017](https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/) — untested backups; destructive action with no verified recovery path
- [Google SRE Book — Monitoring Distributed Systems (ch.6)](https://sre.google/sre-book/monitoring-distributed-systems/) — the four golden signals; symptom-vs-cause alerting
- [Google SRE Workbook — Implementing SLOs (ch.2)](https://sre.google/workbook/implementing-slos/) — SLI/SLO/error-budget definitions; RED (Tom Wilkie) and USE (Brendan Gregg) methods as the request/resource-oriented complements

No major conflicts across sources — they converge on the same core claims (progressive rollout, tested rollback, backward-compatible migrations, bounded blast radius). The only nuance is cost trade-off framing: blue-green is fastest to roll back but doubles infra spend during the switch window, while rolling deployment is cheapest but slowest to fully roll back — pick per risk tolerance, not one-size-fits-all.
