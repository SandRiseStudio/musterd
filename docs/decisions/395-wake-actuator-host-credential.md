# 395 — The wake actuator authenticates with a host-scoped credential no claim path can overwrite

- Status: accepted
- Date: 2026-09-14
- Relates to: ADR 131 (actuator authenticates through the workspace binding), ADR 344
  (claim-scoped vs host-scoped bootstrap credentials), ADR 018 (workspace binding)
- Lane: `01M1T6D80QYWQ9ABHARX7QCW19`

## Context

ADR 131's actuator (`musterd host`) authenticates `POST /residency/wake-leases` with a key read
through the seat's workspace binding. ADR 344 then narrowed `binding.agent_key`: `musterd agent`
writes a **`claim_seat`-scoped** bootstrap credential into that same field, with the comment
"Never fall back to the ambient legacy Team-wide key." The wake-leases endpoint accepts exactly
two bearers: a token hashing to the team agent key, or a bootstrap credential whose `use_kind` is
`host` and whose `target` equals the host label. A `claim_seat` credential is neither.

Measured on delta (`docs/perf/cloud-seat.md` finding 14, 2026-09-06): every wake-lease poll
returned 401 from 2026-09-04T22:36:32Z for 50 h 50 m, across a reboot, ~6,100 polls. The last
success was thirty seconds before delta's first (and only) wake. `sha256(binding.agent_key)` did
not match `teams.agent_key_hash`; `config.agentKeys.revive` still did. Repair was `musterd wire`
then `residency on` — a rebind, not a rotation.

A later measurement (2026-09-06 13:15Z) falsified "the occupy path rewrites the key": after the
rebind, five wakes each claimed and the actuator's polls stayed 200. The 09-04 22:36Z writer ran
once, on a first-boot workspace, and is still unnamed. The field is still shared by three
writers with opposite scopes, so the next first-boot writer — occupy, detach, persistBinding,
`musterd agent`, anything that rebuilds the binding — can disarm the actuator again.

## Problem

The wake actuator and the claim handshake share one secret field. They must not. A seat that
looks `offline · wakeable` while its actuator 401s is a reachability lie, and the 401 lives only
on the machine nobody is looking at.

## Decision

1. `binding.host_key` is an optional secret: a host-scoped bootstrap credential (ADR 344 use
   `host`) whose `target` is the enrolled host label. It lives in the gitignored 0600
   `binding.json`, never in `workspace.json`. Unknown keys on Binding stay rejected; this is an
   additive optional field.
2. `musterd residency on`, when landing the grant in the seat's own workspace, mints that
   credential if `host_key` is absent and writes it. Re-enroll reuses the existing `host_key` —
   no mint-on-every-boot. Mint failure is a warn, not a failed enroll: the grant and host
   registry still land, and the loop falls back to `agent_key`.
3. `saveBinding` (CLI and MCP) merge-guards `host_key`: omit means preserve. Claim, agent, wire,
   occupy, and persistBinding never have to know the field exists. `residency off` passes
   `{ drop: { host_key: true } }` so the kill switch drops the secret along with the grant.
   Server-side revocation of the bootstrap record stays the administrator's (ADR 344 Decision 5).
4. The wake actuator authenticates `/residency/wake-leases` with `host_key`, falling back to
   `agent_key` when the field is absent (workspaces enrolled before this ADR, until the next
   `residency on`). The endpoint already accepts a host-scoped bearer (ADR 344 Decision 4); this
   ADR is the client half.
5. `musterd agent` continues to write a `claim_seat` credential into `agent_key`. That field is
   the claim authenticator, not the actuator's.

## Consequences

- A claim that overwrites `agent_key` no longer disarms the next wake. The unnamed first-boot
  writer can keep writing; it cannot touch `host_key`.
- Existing enrollments keep working on `agent_key` until the next `residency on` (cloud-seat
  `seat.sh` already runs it on every boot).
- Host-scoped credentials accumulate if a workspace loses `host_key` and re-enrolls (wire's
  reconstruct-without-the-field is now merge-guarded, so this should be rare). Rotation remains
  manual.
- Candidate 2 from finding 14 (a 401 on the wake lease should reach the hub / drop `wakeable`)
  is not this ADR. Candidate 3 (`musterd agent` and the wake endpoint should not disagree in
  silence) is closed by splitting the fields rather than by accepting `claim_seat` on the wake
  path.
- ADR 131 Decision is frozen (it already carries a 2026-09-06 marker; a second one would
  strip both and fail `change-adr:check`). The amendment lives in its Consequences.

## Observability & Evaluation

- **Traces:** `bootstrap_credential.used` with `{ use: 'host', target }` on a successful
  wake-lease poll; `bootstrap_credential.refused` with `host_mismatch` when a claim-scoped key
  is presented to the wake path (already shipped, ADR 344). The host log's
  `wake-lease poll failed for <team>` is the client-side trace; it must not carry the secret.
- **Eval:** the CLI host-loop suite plus the saveBinding merge-guard tests. Baseline: a
  workspace whose `agent_key` is a claim-scoped credential polls with that key and 401s.
  Completed: the same workspace with `host_key` set polls with `host_key`; a subsequent
  claim-shaped saveBinding that omits `host_key` still has it on disk.
- **Experiment:** enroll a disposable cloud seat, wake it, let the session claim, confirm the
  next `POST /residency/wake-leases` is 200 without a hand rebind. Falsify: `host.log` shows a
  401 after that claim, or `sha256(binding.host_key)` is absent after `residency on`.
