# res_homelab — The Self-Hosted / Homelab Operating Bar
> Research-backed reference for the Due Diligence homelab-ops lens.

## What good looks like (the bar)

**Config lives in the declaration, not in the running container.** The Twelve-Factor App's config factor requires "strict separation of config from code" — config is everything that varies between deploys (credentials, hostnames, resource handles), and a codebase should be publishable at any moment without exposing a secret, which only holds if nothing is baked into a running instance instead of the versioned template. https://12factor.net/config Most container runtimes rebuild from the stored create-template/compose file on recreate, image update, or host reboot — not from whatever was hand-edited into the live container — so a setting that only exists at runtime silently reverts. The acceptance test is "does it survive restart **and** recreate **and** an image update", not "is it running now."

**A backup is unproven until a restore has verified it.** The 3-2-1 rule — at least 3 copies of data, on 2 different media, with 1 copy off-site — is the baseline shape of a real backup strategy, popularized by photographer Peter Krogh and since adopted by government guidance including CISA's own data-backup recommendations. https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf (origin: https://www.computerweekly.com/feature/The-3-2-1-backup-rule-Has-cloud-made-it-obsolete) Meeting the 3-2-1 shape is necessary but not sufficient: GitLab's January 2017 outage lost roughly 300GB of production data after an engineer deleted the primary database, only to discover that 4 of their 5 backup/replication mechanisms had silently not been working — the incident that makes "backups are running" and "backups are recoverable" two different, unverified claims. https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/ In a homelab specifically, the tool doing the backing up can also have a blind spot for storage it doesn't see (e.g. it walks one kind of mount but not another), and a retention policy that prunes on a fixed schedule but only creates a new copy on success can shrink the chain to nothing after repeated silent failures.

**Irreversible storage/database operations are a one-way door.** Upgrading a storage pool to use new on-disk feature flags is explicitly a one-way operation in mainstream ZFS-based storage systems: TrueNAS's own documentation warns "You can not undo a pool upgrade, and you lose the ability to roll back to an earlier major version" once the upgrade is applied. https://www.truenas.com/docs/scale/storage/pools/managepools/ The same shape of hazard applies to database format migrations and filesystem conversions run in place, and to unattended auto-updates of an OS, plugin, or app with no version pin — each trades a reversible state for an irreversible one on a timer or a single button click. The standard is a verified backup taken immediately before any irreversible operation, and pinning the version of anything whose upgrade changes behavior.

**Startup order and single-host dependencies have to be explicit, not assumed.** Compose-based tooling does not wait for a dependency to be *ready*, only for it to be *running* — a database container can accept `docker start` and still not accept connections yet. Docker's own guidance is to declare the real dependency with a `healthcheck` and a `depends_on: condition: service_healthy`, rather than relying on incidental process-start ordering. https://docs.docker.com/compose/how-tos/startup-order/ On a single host, every service shares one failure domain by construction; the additional homelab-specific hazard is a dependency nobody wrote down — a reverse proxy, an overlay network, or a DNS/tunnel service that has to be up before dependents will work — which fails confusingly (not obviously) when it's slow or absent on boot.

**Finite local resources need monitored headroom, not assumed headroom.** Disk, inodes, RAM, and single-node CPU are all hard limits with no failover to lean on. A concrete, verifiable failure mode: Docker's default `json-file` logging driver ships with `max-size` defaulting to `-1` (unlimited) — meaning container logs grow without bound unless an operator explicitly caps them — a generic instance of "unbounded growth silently consumes a finite resource until the host falls over." https://docs.docker.com/engine/logging/drivers/json-file/ The same pattern applies to ever-growing local backup archives, retained log files, or any other artifact whose growth was never given a ceiling.

**Secrets belong in a reference, not embedded in the declaration.** OWASP's secrets-management guidance treats "avoid storing secrets directly in config files or code" as a foundational principle, and its cryptographic-storage guidance is explicit that keeping keys in dedicated secret storage (HSM, vault, secrets manager) has real advantages over "simply putting keys in configuration files" — centralized management, easy rotation, and not multiplying the places a plaintext secret can leak (backup archive, screen-share, accidental repo commit). https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html ; https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html The homelab-specific mirror image of this is config drift: a setting changed only inside a running container (never written back to the versioned template) is both a leak risk and something that silently reverts on the next recreate — see the config-as-code point above.

**A job that reports success while doing nothing is worse than a job that fails loudly.** The standard pattern for catching this is a dead man's switch: an external monitor that expects a periodic check-in ("ping") from the job and alerts precisely when a ping *fails to arrive* — inverting the usual alert-on-bad-signal model into alert-on-silence. Healthchecks.io's own documentation states the pattern plainly: it "listens for HTTP requests ('pings') ... keeps silent as long as pings arrive on time... raises an alert as soon as a ping does not arrive on time," explicitly citing filesystem/database backups and periodic sync jobs as the canonical use case. https://healthchecks.io/docs/ Without this, "the cron job ran" and "the cron job did the thing" are indistinguishable, and the failure that matters most — the silent one — is the one with no instrumentation pointed at it.

## Common defects (what to attack)
- Setting changed only in a running container (shell exec, live edit) with no corresponding update to the create-template/compose file — reverts on the next recreate, image auto-update, or host reboot.
- No test proving a backup restores — a chain of backups exists but nobody has run a restore against it.
- Backup tool silently skips a storage type it doesn't walk (e.g. one mount kind vs. another), producing a "successful" backup that's missing data.
- Retention that prunes old backups on a fixed schedule regardless of whether a new one succeeded, or that never prunes and grows storage unbounded on repeated failures.
- Storage-pool feature upgrade, database format migration, or filesystem conversion run against production with no backup taken immediately before and no tested rollback.
- Auto-update enabled on an OS, plugin, or app with no version pin — behavior can change on a schedule nobody chose.
- Dependent service started before its prerequisite (database, reverse proxy, overlay network, DNS/tunnel) is actually ready to serve, relying on process-start order instead of a real readiness check.
- Hidden single-point dependency (a tunnel, DNS entry, or bridge network) that nothing documents, so its absence produces a confusing failure in an unrelated service.
- Disk, inode, RAM, or CPU headroom with no monitoring — first sign of exhaustion is an outage.
- A log driver, backup archive, or other artifact left at its unbounded default with no size/retention cap.
- Plaintext secret committed to a config file, compose file, or backup archive instead of referenced from a vault/secret store.
- Running configuration that has drifted from the declared/versioned config and nothing reconciles or flags the difference.
- A scheduled job (backup, sync, cron task) that can exit 0 while doing nothing, with no external check that it actually ran and produced output.
- No dead-man's-switch / alert-on-silence for jobs whose failure would only be noticed when someone needs the thing the job was supposed to produce.

## Quick-reference checklist
- [ ] Every intended runtime setting is captured in the versioned create-template/compose declaration, not only in the live container
- [ ] "Does it survive restart AND recreate AND an image update" is the actual acceptance test for durability
- [ ] Backups meet the 3-2-1 shape: ≥3 copies, ≥2 media/locations, ≥1 off-site
- [ ] A restore has actually been test-run against the current backup chain, not just "the backup job completes"
- [ ] Backup tool's coverage is known — no storage silently excluded from what it walks
- [ ] Retention only prunes after the new backup is verified; growth is bounded, not silently unbounded or silently shrinking
- [ ] Irreversible operations (storage-pool upgrade, DB format migration, filesystem conversion) have a verified backup taken immediately before, and a real rollback path
- [ ] Auto-update is pinned/scoped for anything whose behavior change would matter
- [ ] Service dependencies use a real readiness signal (healthcheck-gated) rather than incidental start order
- [ ] Hidden single-host dependencies (DNS, tunnel, bridge network, proxy) are named and self-healing on reboot
- [ ] Disk, inode, RAM, and CPU headroom are monitored with alerting before exhaustion, not after
- [ ] Logs, backup archives, and other growth artifacts have an explicit size/retention cap, not an unbounded default
- [ ] Secrets are referenced from a vault/secret store, not embedded in plaintext in any config, compose file, or backup
- [ ] Running state matches declared config — drift is detected, not silently tolerated
- [ ] Jobs whose silent failure matters (backups, syncs, scheduled tasks) are covered by an alert-on-silence / dead-man's-switch check, not just alert-on-error

## Sources
- [The Twelve-Factor App — III. Config](https://12factor.net/config) — strict separation of config from code; config as what varies between deploys
- [CISA — Data Backup Options](https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf) — government-adopted statement of the 3-2-1 backup rule
- [ComputerWeekly — The 3-2-1 backup rule: has cloud made it obsolete?](https://www.computerweekly.com/feature/The-3-2-1-backup-rule-Has-cloud-made-it-obsolete) — origin of the 3-2-1 rule (Peter Krogh)
- [GitLab — Postmortem of database outage of January 31, 2017](https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/) — untested backups; "running" vs. "recoverable" are different claims
- [TrueNAS Documentation — Managing Pools](https://www.truenas.com/docs/scale/storage/pools/managepools/) — storage-pool feature upgrades are one-way, no rollback once applied
- [Docker Docs — Control startup and shutdown order in Compose](https://docs.docker.com/compose/how-tos/startup-order/) — `depends_on` + `healthcheck`/`condition: service_healthy` for real readiness, not process-start order
- [Docker Docs — JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/) — `max-size` defaults to `-1` (unlimited); concrete instance of unbounded local-resource growth
- [OWASP Cheat Sheet Series — Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) — secrets referenced from a managed store, not embedded in config
- [OWASP Cheat Sheet Series — Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) — advantages of dedicated key/secret storage over keys "simply put in configuration files"
- [Healthchecks.io Documentation](https://healthchecks.io/docs/) — dead-man's-switch pattern: alert on a missing check-in, not on an observed error, for cron/backup/sync jobs

No major conflicts across sources — they converge on the same underlying claims (declared config over runtime state, tested restore over running backup, one-way ops treated as one-way, explicit readiness over assumed ordering, bounded growth, referenced secrets, alert-on-silence). The only judgment call left to the operator is where to draw the line on monitoring cost vs. coverage for a single-operator setup, which is inherently thinner than a team-run production environment.
