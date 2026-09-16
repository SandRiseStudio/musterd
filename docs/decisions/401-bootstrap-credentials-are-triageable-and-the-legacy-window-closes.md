# 401 — A leaked bootstrap credential is triageable without opening it, and ADR 344's legacy window closes

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
   secret to anything. Two properties make that safe, and both are requirements of this decision,
   not hopes about it:

   - **Non-enumerable.** The ID is the record's ULID: 80 bits of CSPRNG randomness, which is not
     guessable and not walkable. Its 48-bit millisecond prefix is the one thing it does disclose —
     when the credential was minted — and that is accepted as the residual, because an image layer
     that leaked the binding leaked the key beside it and the mint time tells an attacker nothing
     the key does not.
   - **Resolvable only through the admin-authorized inventory.** The ID resolves at exactly one
     place: `GET /teams/:slug/agent-bootstrap-credentials`, already behind `authAdmin`
     (`packages/server/src/transport/http.ts:2624`), surfaced as `musterd team bootstrap list`.
     **No route turns the ID into an oracle.** Claim, routine, `doctor`, and every unauthenticated
     route neither accept it nor vary their behaviour on it — a well-formed ID and a fabricated one
     are indistinguishable to anything but an authenticated admin. The ID is an identifier, not an
     authenticator: presenting it authenticates nothing, and the server never accepts it in place
     of the key.

3. **The legacy record is dated, and its window has an end.** `teams.bootstrap_cutover_at` (already
   in the schema) is set for a Team once every configured workspace holds a scoped credential.
   Until it is set, `musterd doctor` warns with an **aggregate count only** — how many workspaces
   are still on the legacy record, and the command that lists them
   (`musterd team bootstrap list`) — and names none of them. ADR 344 §8 forbids a Workspace path in
   diagnostics, and `doctor` output is the broadly visible diagnostic this ADR must not widen: it
   is pasted into transcripts and issues by people who are not admins of the team it describes.
   Per-workspace identification lives entirely inside the admin-authorized inventory, and there it
   is the redacted workspace **label** ADR 344 §1 already stores — never a path.

   Retiring the legacy path for all teams remains ADR-gated per 344 §7; this decision only requires
   that the window be *measured* and *reported* rather than left open silently, which is what
   fourteen days of silence produced. **This increment is visibility, not enforcement.** Nothing
   here revokes a legacy record, refuses a legacy claim, or closes the compatibility window; a
   warning does not close a path, and this ADR does not pretend otherwise. Closing it is 344 §7's
   ADR, which the measurements below are the precondition for writing honestly.

4. **Rotation states its true blast radius.** `musterd team agent-key --rotate` counts only the
   bindings that actually authenticate with the legacy record, by asking the daemon which record a
   binding's credential resolves to — not by prefix (`startsWith('mskey_')`, which matches scoped
   credentials too). A scoped binding is excluded from the count and said to be unaffected. The
   count is the number and the redacted workspace label, never a Workspace path: rotation output is
   a diagnostic under ADR 344 §8 like any other.

5. **A scoped credential minted for an agent seat carries a 90-day expiry by default.** ADR 344 §6
   made expiry available and §5 left rotation manual; both hold. This narrows only the default:
   `musterd team bootstrap mint` without `--expires-in` mints at **90 days** instead of never, and
   `--expires-in never` becomes the explicit choice. Ninety days is the shortest window that does
   not put an unattended cloud seat on a renewal treadmill — it is a quarter, it is longer than any
   deploy cadence this fleet has run, and it bounds a leak that nobody notices to one quarter
   rather than to forever.

   **The renewal path is the existing staged rotation, and it is zero-downtime.** Re-minting the
   same scope (`musterd team bootstrap mint --seat <name>`) moves the predecessor to `rotated`
   rather than killing it, and `findBootstrapCredential` accepts `active` **and** `rotated`
   (`packages/server/src/store/teams.ts:243,253`), so the old key keeps working until an admin
   revokes it or it expires. Renewal is therefore: mint the successor, write it into the
   workspace's binding, then `musterd team bootstrap revoke <predecessor-id>`.

   **The operator response to an approaching lapse is defined rather than implied.** The inventory
   already carries `expires_at`; `doctor` warns on a scoped credential inside 14 days of expiry
   (again as an aggregate count plus the inventory command, per Decision 3), which is ample for a
   renewal that costs one mint and one file write. A credential that lapses anyway fails closed at
   claim time (ADR 344 §6) with the mint command already in the refusal text
   (`packages/server/src/transport/http.ts:1399`) — the seat cannot claim, and it says exactly how
   to fix it. That is the outage this default risks, and it is bounded, loud and one command deep;
   the alternative is a credential whose leak has no natural end.

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
  (the claim fails closed, ADR 344 §6, with the mint command in the refusal text) and repairable by
  minting a successor, and it is the intended pressure toward rotation actually happening. The
  90-day default plus the 14-day `doctor` warning is what keeps "loud" from meaning "at 3am on an
  unattended cloud seat with no warning" — but it does not eliminate that case, and an operator who
  ignores the warning for a fortnight gets the outage.
- **Nothing here enforces anything.** The legacy record keeps working, legacy claims keep
  succeeding, and the compatibility window stays open until 344 §7's ADR closes it. A reader
  looking for the decision that retires the legacy path will not find it here; this one only makes
  the population countable, which is the evidence that ADR will need.

## Observability & Evaluation

**Traces** — the inventory read is audited as an admin act with actor, team and record count; never
the records' secrets or hashes. Credential-use audit rows (ADR 344 §5) already carry the record ID,
so a spill investigation can join "this ID leaked" to "this ID was used, when, for what target".

**Eval** — the measures are the table in Problem, re-read: legacy records outstanding, workspaces
still on the legacy record per team, scoped credentials without an expiry, and teams with
`bootstrap_cutover_at` still NULL. The baseline is 2026-09-15: 6 legacy records, 0 cutovers set,
2 scoped credentials, 0 of them expiring. Two of these are aggregate counts by construction — they
are read from the daemon's own tables by an admin, not from `doctor` output, so measuring them
costs nothing in diagnostic exposure. Success is the first three trending to zero and the
fourth to every team; failure is another fourteen days with the table unchanged, which is the
outcome this ADR exists to make visible.

**Experiment** — replay this incident against the decision. Take a binding from a build context,
read only its record ID, and answer from the inventory alone: what may this claim, is it still
active, and does rotating the Team key affect it. Success is all three answered without the secret
being read by anyone. The falsifier is a binding whose ID resolves to nothing an operator can act
on — which would mean the inventory is decoration and the operator is still pushed to open the key.

A second, adversarial run falsifies Decision 2's no-oracle claim rather than the inventory's use.
Hold the record ID and no credential. Present it to claim, to a routine, to `doctor`, and to every
unauthenticated route, alongside a fabricated ID of the same shape. Success is that no response,
status code, error text or latency distinguishes the two. Any route that treats a real ID
differently from a fabricated one is an enumeration oracle on the credential population, and this
decision does not survive it: the binding goes back to carrying no ID at all.

A third falsifies Decision 3's §8 bound directly: run `musterd doctor` on a hub with legacy
workspaces and grep its output for a Workspace path or workspace-identifying label. One hit and
the aggregate-count rule has not been implemented, whatever the ADR says.
