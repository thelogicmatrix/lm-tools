# backup-recovery — If this is lost, can you actually get it back?
> Cites: res_operations.md (Backup & recovery)

## Fires on
Tags: infra, deploy. Select for any system holding data whose loss would matter (databases, appdata, config, stateful services). A backup you have never restored is a hope, not a backup.

## Attacks
- Backups running but never test-restored — recoverability is unproven until a real incident disproves it.
- No RPO/RTO defined — no target for acceptable data loss or downtime, so "we have backups" can't be evaluated.
- 3-2-1 violated: a single copy, single location, or no off-site copy — one failure, disk death, or ransomware event loses everything.
- Retention trap: a job that prunes old backups on schedule but only creates a new one on success — a silent failure shrinks the chain to nothing (or a verify-failure balloons storage because nothing prunes).
- Destructive operation (drop/delete/one-way transform) with no verified backup taken immediately before.
- Retention policy absent or unmonitored — unbounded growth, or silent shrinkage on repeated failure.

## Evidence of attack (clean-pass proof)
State what's backed up, how many copies/locations/off-site (3-2-1), the RPO/RTO and whether cadence/restore-speed meet them, and when a restore was last actually tested. Confirm pruning happens only after a verified new backup. Name the gap or confirm each with specifics — "backups are configured" is not evidence.

## Severity guide
- blocker: no tested restore path, a single-copy/no-off-site setup, or a retention job that can silently destroy the chain — data loss is a matter of when, not if.
- should-fix: backups exist and are multi-copy but RPO/RTO undefined, or test-restore is stale/never scheduled.
- nit: retention window could be tuned; off-site copy could be more frequent.
