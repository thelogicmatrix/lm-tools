# Homelab / self-hosted infrastructure — operating standard

Backs the `homelab-ops` lens. Generic to any single-operator, self-hosted, often
single-host deployment (containers, a reverse proxy, local storage pools, scheduled
jobs). No vendor/host specifics — those belong in the operator's own runbook.

## Restart & recreate durability (config-as-code)
A container/service is only as durable as the declaration it is rebuilt from. Runtime
mutations — a shell into a running container, a manual network attach, a hand-edited live
config — do not survive a recreate, an image auto-update, or a host reboot, because most
runtimes bake environment and arguments in at *create* time and rebuild from the stored
template/compose file, not from the running state. The standard: every intended setting
lives in the versioned declaration; "does it survive restart AND recreate AND
auto-update?" is the acceptance test, not "is it running now?".

## Backups you have never restored
A backup is a hope until a restore proves it. Homelab-specific failure surface on top of
generic 3-2-1: (a) storage the backup tool cannot see — e.g. named volumes vs bind mounts —
gets silently skipped; (b) a tool that reports success while dropping items hides the gap;
(c) retention that prunes on a schedule but only creates on success can shrink the chain to
nothing after repeated silent failures. Standard: know what is covered, that a restore was
actually tested, and that pruning happens only after a verified new copy.

## In-place upgrade hazard
One-way, irreversible operations on stateful systems — storage-pool feature upgrades,
database format migrations, filesystem conversions — run against production with no
tested rollback are the highest-blast-radius mistake in a homelab. Auto-updating an OS or
plugin with no version pin is the same hazard on a timer. Standard: irreversible ops get a
verified backup immediately before and a rollback path; behaviour-changing components are
pinned.

## Single-host SPOF & startup ordering
One box means every service shares one failure. Beyond that: services with implicit
ordering (a network/bridge/proxy or a DNS/tunnel that must exist before dependents start)
fail confusingly when the prerequisite is absent or slow; a scheduled restart/backup
window becomes a dependency nobody documented. Standard: startup prerequisites are explicit
and self-healing on reboot; hidden dependencies (DNS, tunnel, ordering) are named.

## Resource exhaustion
Finite local resources fail hard when silently consumed: disk and inodes, firmware NVRAM
entries, RAM/swap, and single-node CPU under concurrent load. An unbounded log or an
ever-growing backup is a slow exhaustion. Standard: headroom is monitored on every finite
resource that, when full, takes the system down; growth is bounded.

## Secrets in env / config drift
Plaintext secrets in templates or compose files leak on backup, screen-share, or repo
push. Config that exists only inside a running container (never written back to the durable
template or version control) is lost on the next recreate and drifts from what is declared.
Standard: secrets are referenced, not embedded; the running state matches the declaration.

## Silent-failure blindness
The worst homelab failures are the ones nothing tells you about: a job that exits reporting
success while doing nothing, a degraded state with no alert, a recoverability you never
verified. Standard: the paths whose failure matters emit an alert on failure (not just on
success), and "it ran" is distinguished from "it did the thing".
