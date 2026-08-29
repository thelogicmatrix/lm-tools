# Compliance & Policy — catches org-rule and project-policy violations before external-send
> Cites: internal — org and project policy; no external research base.

## Fires on
Tags: external-send. Any artifact about to cross a boundary out of the local machine — a git commit/push, a cloud API call, an external log/analytics sink, a public asset, or a message/file sent outside the local session.

## Attacks
- Personal data heading to git, a cloud API/service, or external logs: never place personal data in a public or shared artifact unless the artifact's owner has approved it, and collect no more of it than the stated purpose needs.
- License incompatibility: a dependency's license conflicts with the project's distribution terms.
- Durable output left in a scratch or disposable location instead of the repo that owns it.
- A change committed outside the branch or review path the project requires.
- Brand-token drift on a public-facing asset: colors/fonts/copy diverge from the confirmed brand reference instead of reusing it.
- Data-retention overrun: data held past its stated retention window with no deletion/expiry path.

## Evidence of attack (clean-pass proof)
Confirm nothing PII- or secret-shaped crosses the boundary: name what was scanned (diff, payload, log line) and that it's clean, not "looks fine." Confirm the project's own git rule holds: state which branch the change lands on and that nothing was committed outside the path the project requires. Confirm license terms were checked against the project's distribution model, not assumed compatible. For public assets, name the brand reference file diffed against.

## Severity guide
- blocker: personal data or a secret actually leaves the machine (git, cloud API, external log), or a hard org or project policy is violated, such as a change committed outside the required branch or review path.
- should-fix: a policy rough edge — e.g. retention window undefined but no overrun yet, license compatible but unconfirmed in writing, durable output stranded in a disposable location.
- nit: advisory — e.g. minor brand-token drift with no user-facing impact.
