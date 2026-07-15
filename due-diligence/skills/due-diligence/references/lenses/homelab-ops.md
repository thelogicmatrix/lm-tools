# homelab-ops — Will this homelab change (or system) break on restart, recreate, or a bad day?
> Cites: res_homelab.md

## Fires on
Tags: infra, deploy, config, cron. Select for any single-operator / self-hosted / often
single-host deliverable — a container or template change, a compose/deploy, a storage-pool
operation, a backup or scheduled-job config — OR when auditing a live homelab for latent
fragility. Generic; the operator's own runbook supplies host specifics.

## Attacks
- **Restart/recreate durability.** Config applied at runtime (in-container tweak, manual
  network attach, hand-edited running container) that a recreate / image auto-update / host
  reboot silently reverts. Env & args bake in at create. Test: survives restart AND recreate
  AND auto-update?
- **Backups never restored.** Named-volume vs bind-mount coverage; a backup that reports
  success while skipping items; prune-on-schedule-but-create-on-success retention that can
  silently shrink the chain. (Pairs with backup-recovery for the generic 3-2-1 checks.)
- **In-place upgrade hazard.** One-way / irreversible ops on pools/DBs/storage run on
  production with no tested rollback; OS/plugin auto-update shifting behaviour with no pin.
- **Single-host SPOF & startup ordering.** Everything on one box; a scheduled
  restart/backup window services depend on; network prerequisites (bridge/proxy) that must
  exist before dependents start; DNS/tunnel as a hidden dependency.
- **Resource exhaustion.** Disk / inode / NVRAM / RAM headroom; an unbounded log or backup;
  single-node CPU under concurrent load.
- **Secrets in env / config drift.** Plaintext secrets in templates/compose; config that
  lives only in a running container, not in the durable template / version control.
- **Silent-failure blindness.** Jobs that fail silently (success-reported failure); no
  alert on the paths that matter; recoverability unproven.

## Evidence of attack (clean-pass proof)
For each Attack, state the observed value or the check performed and why it passed — not
"looks fine". For a change: show it is declared (survives recreate), rollback exists, no
plaintext secret, no new SPOF/ordering trap. For a live audit: cite the sweep output per
risk. A pass requires evidence on every Attack, not silence.

## Severity guide
- blocker: data loss is when-not-if (untested restore, retention that can destroy the
  chain), an unrecoverable/production-bricking in-place op, or a secret exposed.
- should-fix: real fragility use will hit — reverting-on-recreate config, undefined
  headroom on a resource that can fill, a silent-failure path with no alert.
- nit: tuning (retention window, headroom margin, log rotation cadence).
