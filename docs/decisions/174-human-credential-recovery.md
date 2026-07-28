# 174 — A lost human credential is recoverable, and the bar for recovery is not the thing you lost

- Status: proposed — 2026-07-28. Authored by izzo (lane `01KYMXZWR627DFSVSWK0GRRRZN`). The decision
  was pre-registered by miley in `docs/design/install-topology.md` §6(b); this ADR is that decision
  written down where it can be argued with. Number **174** — next free above ADR 173 at landing time; 173 was claimed by another
  branch while this one was in flight, which is the collision gate doing its job.
- Date: 2026-07-28
- Builds on: [ADR 069](069-v0.3-governance-build-plan.md) (the `mscr_` human credential),
  [ADR 075](075-p3.3-cli-claim-surface-migration.md) (agents authenticate with the team key, not a credential),
  [ADR 134](134-provisioning-is-localhost-trust-enforced.md) (`authProvision` — the bar this route
  sits at), [ADR 170](170-signin-handoff.md) (the sign-in handoff whose premise this restores),
  [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md) (the audit row that makes the bar defensible).

## Context

`members.credential_hash` is a single column. `mintCredential` overwrites it, and its only callers
were team-create and new-member add. `POST /members` conflicts on a live member, and there was no CLI
verb at all. Put together: **a human who lost their `mscr_` had no path back onto their own team**
short of hand-editing the daemon's SQLite file.

This is not a hypothetical. It is the state the founder's own dogfood team was in on 2026-07-28: the
`revive` credential for `nick` exists nowhere on his machine. That fact also falsified ADR 170's
central premise — _"the CLI already holds your credential"_ — on the very machine ADR 170 shipped
from. `musterd board` cannot sign him in, so the entire human-work-identity arc (item 5: human lanes,
the insight rail saying "the team is blocked on nick") is unreachable for the one human it was built
for. The first datum against ADR 170's assumption was earned honestly, by using it.

Two constraints shape the answer:

- **A member cannot hold two credentials.** The one-column schema is exactly what ADR 170 declined to
  migrate. Nothing here changes that; a second credential remains a schema change looking for a
  requirement that justifies it, and "I lost mine" is not that requirement — it is the requirement
  _rotation_ serves.
- **The caller has no credential.** Whatever bar recovery sits at, it cannot be one that is proven by
  presenting an `mscr_`.

## Decision

**Rotate in place: `POST /teams/:slug/members/:name/credential/rotate`, at the `authProvision` bar —
localhost unauthenticated, admin credential off-host.**

Mint, audit `credential.rotate`, return the secret **once**. The old secret is dead at the next
claim; live sessions ride out, exactly as the agent-key rotate has always behaved (this route is
modelled on it deliberately — a team's shared key and a human's credential are the same kind of
object with the same kind of loss). Humans only: an agent seat authenticates with the team agent key
and has no per-seat credential to lose, so asking to rotate one is a `400` that says so.

**The bar is the whole decision, and admin-only would be wrong.** Admin-only is circular precisely
in the case that matters: the primary caller is the admin, and the credential they lost is the one
admin auth would demand. It fails exactly when it is needed and works only when it is not. The
positive argument is stronger than the escape from circularity, though: **re-minting for an existing
human is not a more powerful act than minting for a new one**, and minting for a new one has sat at
`authProvision` since ADR 134 — including for an observer seat, which reads the team's directed
messages. A bar that admits "mint a fresh identity that can read everyone's DMs" cannot coherently
refuse "re-issue an existing human's own credential."

The residual risk is real and named: **any process on the daemon host can rotate any human's
credential.** That is ADR 134's accepted boundary, not a new hole — the same local process could
already mint itself an observer seat and read the DMs it wanted. What keeps the bar defensible is
that rotation is **self-announcing**: a `credential.rotate` audit row lands, and the victim's own
secret stops working, so a rotation nobody authorized is loud in both directions. Compare the
alternative posture, where the only recovery is DB surgery: that is _also_ available to any local
process, and it writes no audit row at all. Naming the operation makes it more observable than
leaving it unnamed, not less.

**CLI: `musterd team credential <name>`.** Prints the credential shown-once. Deliberately
identity-free — it resolves the team from flags/config rather than through `resolve()`, because
requiring an active identity would reintroduce the circularity at the client end. When this machine
already knows `(team, name)` it repairs what went stale in the same breath: the ADR 059 vault entry,
the team's active identity slot, and the workspace binding when that folder is bound to the same
seat. That last one is what makes `musterd board` work immediately afterwards with nothing pasted
anywhere — which is the actual point of the lane. Rotating **someone else's** credential writes none
of it: their secret is not a sign-in for this machine.

## Alternatives considered

**Admin-only, with DB surgery as the founder's escape hatch.** The tidier-sounding posture. Rejected
because it is not a posture, it is a gap with a manual workaround: it leaves the one case that
actually occurred outside the product, unaudited, and reachable only by someone who knows the schema.
A recovery path that only works for people who can write SQL against the daemon is not a recovery
path.

**Bounded second credential (the ADR 170 deferral).** The right foundation for _cross-device_
sign-in, and still deferred. It buys nothing here: recovery does not need two live credentials, it
needs the one to be re-issuable. Spending a migration on a use case that rotation already serves
would also make the cross-device thread harder to argue on its own merits later.

**A recovery flow through the ask stream** (rotate raises an `approve` ask to another admin). The
musterd-native shape, and genuinely attractive on a team with several admins. Rejected for this
team's reality: `revive` has exactly one human, so the approver of nick's recovery would be nick, via
a credential he does not have. Worth revisiting the day a team has a second human admin — at which
point the honest form is a _policy knob_, not a change to this route's floor.

**Out-of-band delivery** (mail it, print it to a file). Rejected on the ADR 051 no-secrets-in-logs
rule and the same reasoning ADR 170 used against putting a credential in a link: the shown-once
terminal print is the narrowest transport that works, and the CLI's local repair means the common
case never handles the string at all.

## Security

- **No new authority relative to ADR 134.** The route mints for an _existing_ member at the same bar
  where minting a _new_ member (including a DM-reading observer) already sits. Off-host it requires an
  admin credential; that path is unchanged.
- **Humans only.** An agent seat is refused, so this can never manufacture a per-seat credential for
  an agent — the same authority boundary the claim-kind guard enforces on occupancy.
- **Self-announcing.** One `credential.rotate` row per rotation: `target` = the seat, `detail =
{ via: 'local' | 'admin' }`, `actor` = the off-host admin who authenticated, or `null` for the
  loopback caller the route trusts by construction. Anonymity on loopback is stated, not smuggled.
- **No secrets recorded.** The credential and its hash never enter the audit row, the logs, or any
  file the CLI writes beyond the two it already stores secrets in (the 0600 config and the 0600
  binding).
- **Bounded blast radius.** A rotation invalidates exactly one member's credential. It cannot grade a
  seat, grant admin, or touch anyone else's identity.

## Observability & Evaluation

**Traces.** `credential.rotate` on the existing governance audit channel, with the `via` field
distinguishing the loopback recovery from the off-host admin action. The row is the compensating
control the sub-admin bar is justified by, so it is load-bearing rather than decorative — a rotation
that wrote no row would make the whole argument above false.

**Evaluation.** The claim is narrow: _a human locked out of their own team can get back in, without
DB surgery and without an admin they cannot reach._ The measure is the acceptance run itself —
nick's `revive` credential re-issued, `musterd board` opening him signed in, with no paste. That is
n=1 by construction and honestly so: this team has one human, and a recovery verb that works for him
on the day he needs it is the whole population.

**The counter-signal worth watching:** `credential.rotate` rows with `via: 'local'` that no human
initiated. Zero is the expected count forever; a nonzero one would mean some automation is rotating
credentials as a side effect, which is exactly the failure the sub-admin bar risks and exactly what
the row exists to catch. A second signal, softer: repeated rotations for the same member inside a
short window would say the _loss_ is recurring — a storage problem this ADR would then be papering
over rather than solving.

**Experiment.** None. There is no arm to compare and no population to split; the instrument is the
audit series above.

## Increments

1. **This ADR** — the decision, the bar and why it is not admin-only, the pre-registered signals.
2. **Daemon + CLI** (this lane) — the rotate route with its guards and audit row, `musterd team
credential <name>` with the local vault/identity/binding repair, and through-DB tests covering the
   loopback mint, the off-host admin bar, the dead-old-secret-at-claim path, the agent-seat refusal,
   and the departed-member 404.
3. **The founder acceptance run** — nick's own credential re-issued on `revive`, then `musterd board`
   with nothing pasted. Requires a `service refresh` of the shared daemon, which is his call, not a
   seat's.
