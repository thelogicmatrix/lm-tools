# Compliance & Policy — catches org-rule and routing-doctrine violations before external-send
> Cites: CLAUDE.md / org rules (bespoke lens — no res_ file; documented exception)

## Fires on
Tags: external-send. Any artifact about to cross a boundary out of the local machine — a git commit/push, a cloud API call, an external log/analytics sink, a public asset, or a message/file sent outside the local session.

## Attacks
- Customer PII heading to git, a cloud API/service, or external logs — hard org rule (org instructions: never include customer PII data), no exceptions.
- License incompatibility: a dependency's license conflicts with the project's distribution terms.
- Routing-doctrine violation: durable output written only under `.claudework` instead of the personal repo, or a direct commit to a non-meta path from home (only `docs/`, `.claude/`, `.claudework/` are direct-editable at home; everything else needs a worktree per project on its own branch off master).
- Brand-token drift on a public-facing asset: colors/fonts/copy diverge from the confirmed brand reference instead of reusing it.
- Data-retention overrun: data held past its stated retention window with no deletion/expiry path.

## Evidence of attack (clean-pass proof)
Confirm nothing PII- or secret-shaped crosses the boundary: name what was scanned (diff, payload, log line) and that it's clean, not "looks fine." Confirm the git rule holds: state which branch/worktree the change lands on and that no direct commit hit a non-meta path at home. Confirm license terms were checked against the project's distribution model, not assumed compatible. For public assets, name the brand reference file diffed against.

## Severity guide
- blocker: PII or a secret actually leaves the machine (git, cloud API, external log), or a hard org/routing rule is violated (direct commit to non-meta path at home, durable output stranded in `.claudework`).
- should-fix: a policy rough edge — e.g. retention window undefined but no overrun yet, license compatible but unconfirmed in writing.
- nit: advisory — e.g. minor brand-token drift with no user-facing impact.
