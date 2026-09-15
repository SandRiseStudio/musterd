# 397 — A leaked bootstrap credential is triageable without opening it, and ADR 344's legacy window closes

- Status: proposed
- Date: 2026-09-15
- Relates to: [ADR 344](344-scoped-rotatable-agent-bootstrap-credentials.md) (scoped, rotatable
  agent bootstrap credentials), [ADR 337](337-agent-http-session-authority.md) (routine agent authority),
  [ADR 390](390-the-cloud-seat-holds-what-its-job-needs.md) (least privilege on the cloud seat),
  [ADR 328](328-machine-credential.md) (machine credentials)

## Context

ADR 344 (accepted 2026-09-01) already decided the shape this ADR does **not** re-open: the
Team-wide bootstrap secret is replaced by per-target, independently revocable credential records,
and a compromised scoped credential can initiate claims only for its assigned target. That decision
is right and stands.

Two of its clauses are load-bearing here. §7 keeps the existing Team `agent_key_hash` as a marked
`legacy` record "solely for a documented compatibility window", and requires a separate ADR to
remove the compatibility path "after every configured Workspace has moved to a scoped credential".
§8 keeps the opaque `mskey_` value as the claim protocol's input for every record kind, scoped and
legacy alike — the server identifies the record by hash.

On 2026-09-15 a credential leak made the cost of those two clauses together concrete. A seat
binding entered a Docker build context (`.dockerignore` did not exclude `.musterd/`) and was
published to a container registry. Four images were pulled and their layers listed: three cloud-seat
tags spanning the deploy history and one broadcast image. `app/.musterd/binding.json` was present in
all four. The remediation question — *what does this key authorize, and whose is it* — could not be
answered from outside the secret.

## Problem

Measured on the hub daemon the same day, and the reason this is a decision rather than a chore:

| fact | value |
| --- | --- |
| `teams.bootstrap_cutover_at` for `revive` | **NULL** — 344's window still open after 14 days |
| `legacy` bootstrap records, all teams | **6**, state `active` |
| `claim_seat` scoped records | **2** (`delta`, `schmidt`) |
| scoped records carrying an expiry | **0** |
| seat bindings on the hub laptop holding an `mskey_` value | **13** |

So the migration ADR 344 authorised has moved two workspaces in fourteen days, the window it opened
has no closing date, and nothing distinguishes the two populations from outside: a scoped
credential and the legacy Team-wide record are both `mskey_…` in a binding, by §8's design.

Three consequences follow, and the third is the one that turns a spill into an outage.

1. **A leak cannot be triaged.** Reading the secret is the only way to learn what it authorizes.
   The operator responding to a spill is pushed toward opening the credential — the one action that
   most widens exposure — to decide how far the spill reaches.
2. **The legacy record is the default, not the exception.** Only two scoped records exist in any
   team, and one of them (`delta`) belongs to a workspace on another machine — so at most one of
   the hub's thirteen bindings is scoped and the rest ride the legacy record. ADR 344's central
   consequence ("rotating one agent no longer requires changing every other agent Workspace") is
   not yet true for this team in practice.
3. **The blast radius is mis-stated by our own tooling.** `musterd team agent-key --rotate` counts
   stale bindings by prefix (`startsWith('mskey_')`), which matches scoped credentials too. It
   therefore reports that rotating the Team key invalidates thirteen bindings when the true number
   is the legacy subset. An operator mid-incident is told the fleet breaks when it does not.

## Decision

1. **A bootstrap credential is inventoried as a first-class object.** An admin-only inventory
   lists every record for a Team with its `use_kind`, `target`, `state`, `expires_at`, creator and
   lifecycle timestamps, and the workspace label ADR 344 §1 already stores. No secret, no raw hash,
   no workspace path — ADR 344 §8's redaction rule is unchanged. This is the projection §8
   anticipated ("unless an admin inventory response needs a redacted projection"); this ADR says it
   does.

2. **A binding can name its credential without revealing it.** The binding records the credential's
   opaque record ID alongside the secret. An operator holding a leaked binding — or an image layer
   containing one — can then ask the inventory what that ID authorizes without presenting the
   secret to anything. The ID is an identifier, not an authenticator: presenting it authenticates
   nothing, and the server never accepts it in place of the key.

3. **The legacy record is dated, and its window has an end.** `teams.bootstrap_cutover_at` (already
   in the schema) is set for a Team once every configured workspace holds a scoped credential.
   Until it is set, `musterd doctor` reports the count of workspaces still on the legacy record as
   a warning, naming each. Retiring the legacy path for all teams remains ADR-gated per 344 §7;
   this decision only requires that the window be *measured* and *reported* rather than left open
   silently, which is what fourteen days of silence produced.

4. **Rotation states its true blast radius.** `musterd team agent-key --rotate` counts and names
   only the bindings that actually authenticate with the legacy record, by asking the daemon which
   record a binding's credential resolves to — not by prefix. A scoped binding is excluded from the
   count and said to be unaffected.

5. **A scoped credential minted for an agent seat carries an expiry by default.** ADR 344 §6 made
   expiry available and §5 left rotation manual; both hold. This narrows only the default: minting
   without an expiry becomes an explicit choice rather than the path of least resistance, because a
   credential that cannot expire is one whose leak has no natural end.

This decision does **not** add scheduled rotation, compromise detection, or automatic revocation.
ADR 344's closing consequence defers those to the claim-abuse-controls decision, and nothing
measured here supplies the signals that work would need.

## Consequences

- Responding to a spilled binding no longer requires reading the secret. The record ID in the
  binding plus the inventory answers "what does this authorize" from public data.
- The legacy population becomes visible and shrinking rather than invisible and static. A team that
  never finishes migrating is now noisy about it, which is the condition under which 344 §7's
  removal ADR can honestly be written.
- One incident-time lie is removed: the rotate command stops over-reporting its own blast radius.
- Storing a record ID in the binding widens what a leaked binding discloses by exactly one opaque
  identifier. That is the deliberate trade: the ID tells an operator with inventory access what the
  key authorizes, and tells an attacker holding the key nothing they do not already have, since
  they hold the key itself.
- Default expiry will strand a workspace whose credential lapses unnoticed. That failure is loud
  (the claim fails closed, ADR 344 §6) and repairable by minting a successor, and it is the
  intended pressure toward rotation actually happening.

## Observability & Evaluation

**Traces** — the inventory read is audited as an admin act with actor, team and record count; never
the records' secrets or hashes. Credential-use audit rows (ADR 344 §5) already carry the record ID,
so a spill investigation can join "this ID leaked" to "this ID was used, when, for what target".

**Eval** — the measures are the table in Problem, re-read: legacy records outstanding, workspaces
still on the legacy record per team, scoped credentials without an expiry, and teams with
`bootstrap_cutover_at` still NULL. The baseline is 2026-09-15: 6 legacy records, 0 cutovers set,
2 scoped credentials, 0 of them expiring. Success is the first three trending to zero and the
fourth to every team; failure is another fourteen days with the table unchanged, which is the
outcome this ADR exists to make visible.

**Experiment** — replay this incident against the decision. Take a binding from a build context,
read only its record ID, and answer from the inventory alone: what may this claim, is it still
active, and does rotating the Team key affect it. Success is all three answered without the secret
being read by anyone. The falsifier is a binding whose ID resolves to nothing an operator can act
on — which would mean the inventory is decoration and the operator is still pushed to open the key.
