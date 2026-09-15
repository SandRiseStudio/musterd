# 341 — Shared-team credential custody

- Status: accepted as a **gate**; implementation deferred on a named trigger — 2026-09-04 (ryder,
  lane `01M1MMKHX8WXASZT6CGWPNJ4ES`; status flip confirmed by nick on merge). The requirement in
  decision 2 is in force now and blocks a real-user release. Decisions 3–5 describe a barrier nobody
  is building yet, and the trigger that starts it is named below.
- Date: 2026-09-01

## Context

ADRs 039 and 040 already decide the transport posture: a private overlay is
the first cross-machine path, a self-hosted daemon may bind beyond loopback
only with TLS or an explicit trusted-proxy acknowledgement, and a hosted relay
is not scheduled. The v0.3 claim/grant model authenticates a Member over that
transport.

It does not prevent an agent process and a human process that share an OS
account from reading each other's credentials. ADR 200 records this as a
release gate. An OS keychain protects secrets at rest, but cannot establish
identity separation when both processes invoke the same binary under the same
OS account.

## Problem

Define the supported shared-team deployment and the boundary that makes a
human credential unavailable to an agent Member, without treating secret
storage as a substitute for credential custody.

## Decision

1. Shared teams use the existing overlay-first or secured-TLS deployment
   posture from ADRs 039/040. A hosted relay remains out of scope.
2. A release for real users requires each agent Member to run under a distinct
   OS user from every human credential holder. The human credential store is
   readable only by its owning OS user; a 0600 shared vault is
   development-only and cannot satisfy this gate.
3. OS secure storage protects secrets at rest but is not the custody boundary.
   Implement macOS Keychain support first, then equivalent native stores on
   supported platforms. A missing secure store fails closed for real-user
   shared deployments; an explicit plaintext fallback is available only in
   development mode and warns on every use.
4. The migration imports existing credentials into the owning user's secure
   store, verifies the import before removing plaintext, and retains a
   user-owned encrypted backup until the operator confirms recovery. Secret
   values never enter logs, audit detail, health responses, or diagnostics.
5. The daemon database encryption key follows the same ownership model, but
   the database-encryption mechanism and its native dependency remain a later
   ADR. This decision does not add a dependency or alter database bytes.

## Consequences

- The only near-term cross-machine prerequisite is an operator guide and
  acceptance coverage for the existing overlay/TLS paths; no new transport
  protocol is introduced.
- Provisioning must eventually create an agent OS-user boundary and verify
  workspace, git, daemon reachability, and MCP configuration under that user.
- Keychain integration is an at-rest storage migration, not evidence that an
  agent cannot authorize as a human.
- Multi-admin, scoped bootstrap keys, abuse controls, signed audit evidence,
  and database encryption remain separately ADR-gated work.

## Observability & Evaluation

- Traces: secure-store diagnostics report only store availability and
  credential kind, never values or paths.
- Eval: the release acceptance dataset is a two-OS-user Team over the existing
  overlay/TLS paths. Its baseline demonstrates that a shared OS user can
  present a human credential; the completed boundary must make that attempt
  fail while both Members continue to connect.
- Experiment: prototype agent provisioning under a separate OS user on a
  disposable Team, measuring workspace, git, daemon reachability, and MCP
  configuration failures before selecting the implementation lane.

## Disposition — 2026-09-04

Left `proposed` for three days with zero citations in code, wiki or any other ADR, which reads as
undecided when it is not. Two different things were sitting under one status.

**The gate is in force and needs nothing built.** Decision 2 — every agent Member runs under a
distinct OS user from every human credential holder before a release to real users — is a
restatement of the release gate [ADR 200](200-credential-custody-and-the-real-use-gate.md)
set on 2026-07-31, applied to the shared-team deployment. It binds today. A `0600` shared vault
remains development-only, which is what this machine is.

**The barrier is deferred, and ADR 200 already named the trigger.** ADR 200 chose not to build a
barrier; it said the barrier is separate work, and that (1) "should be prototyped first because a
negative result there changes the shape of everything else" — where (1) is the separate-OS-user
answer this ADR adopts. This ADR's own Experiment section describes exactly that prototype, so the
deferral is on its own experiment, not on a date.
Follows-up: deferred — the ADR 200 §(1) prototype: agent provisioning under a separate OS user on a
disposable Team, reporting pass/fail for each of workspace access, git identity, daemon reachability
and MCP configuration. A failure in any of the four is the negative result ADR 200 says changes the
shape of the decision, and reopens decisions 3–5 for redesign rather than implementation (2026-09-04)

**Not deferred because it is unimportant.** The threat is real and ADR 200 documents it; it is
deferred because the seats on this machine have no adversary and the prototype that would tell us
what the barrier costs has not been run. Keychain work (decision 3) is at-rest storage and explicitly
*not* the custody boundary — building it first would look like progress on custody and would not be
any, which is the trap this ADR's own Consequences section already names.
