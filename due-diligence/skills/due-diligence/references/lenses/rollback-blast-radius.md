# Rollback & Blast Radius — catches changes that can't be undone or hit too much at once
> Cites: res_operations.md

## Fires on
Tags: deploy, migration, infra. Any artifact that ships a change to running infrastructure, data, or a schema — deploy scripts, migration files, infra-as-code, rollout configs.

## Attacks
- Irreversible change with no backup taken immediately before it runs (schema drop, data delete, destructive migration, one-way transform).
- Unbounded blast radius: change ships to 100% of traffic/users/regions at once with no canary, no percentage ramp, no cell/shard boundary.
- No rollback path defined, or a rollback path that exists on paper but has never been executed/tested.
- Destructive migration bundled in the same deploy as the code that stops using the old schema — breaks the expand-contract pattern, so app rollback can't happen without a separate DB rollback.
- Backup/restore procedure that has never been test-restored — "backups are running" isn't proof they can be restored from.
- No monitoring/alerting or abort criteria wired up before the rollout starts — watching dashboards manually instead of automated thresholds.

## Evidence of attack (clean-pass proof)
Name the exact rollback command/switch and state whether it has been run (staging or a prior release) — "has a rollback section" is not evidence, a demonstrated execution is. Name the blast-radius bound in force (canary %, shard/cell boundary, rolling-batch size) and confirm it's not a single 100% cutover. For any destructive DDL or data deletion, name the backup/snapshot taken immediately prior and whether it's been test-restored. If a schema change ships, confirm it stays backward-compatible with the previous app version (expand-contract, not expand+contract in one deploy).

## Severity guide
- blocker: irreversible change with no backup, or no rollback path exists at all.
- should-fix: a rollback path exists but has never been tested/executed; blast radius bound is present but wider than necessary.
- nit: deploy window/timing choice (e.g. avoidable but non-catastrophic risk window).
