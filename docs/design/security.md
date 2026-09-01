# Security — threat model & principles

> **Status: v0.3 shared-Team security model.** Security is a first-class principle (Principle 7: _secure by default_). Grants, audit, agent-seat credentials, Presence-bound leases, and ADR 344's scoped bootstrap credentials are implemented. The daemon remains local-first and `127.0.0.1`-bound by default; off-loopback operation requires the secured-bind controls below.

## Principle 7 — secure by default

A musterd team protects identities and the work done under them. The defaults are the safe ones; convenience is an explicit, admin-made, auditable opt-in. No identity is occupied, and no privileged action taken, without an authenticated, authorized, recorded step.

Concretely:

1. **Least privilege.** An **agent bootstrap credential** is restricted by its server-held record to one seat claim, one declared role pool, or one residency host. It cannot be a Member identity, govern, or reach routine HTTP routes. Each occupied agent instead uses its own rotatable seat credential plus a short-lived lease bound to that Presence. A **grant** authorizes exactly one seat/role, expires, and is revocable. Governance requires **admin**. No credential does more than its job.
2. **Authorize-then-occupy.** Occupying a seat needs an agent key **and** an admin-issued grant. **Default = live admin approval per claim.** Pre-issued grants are a per-team admin opt-in (`allow_pre_issued_grants`), never the default.
3. **Everything privileged is audited.** Grant issue/use/revoke, claim/occupy/release, account-status changes, key rotation, policy changes, and request decisions all append to an immutable audit log: `{ ts, actor, action, target, result }`.
4. **Secrets are hashes at rest, never logged.** Agent keys, grants, agent-seat credentials, leases, and human credentials are stored only as hashes server-side. They never appear in logs (structured logger redacts), errors, or telemetry.
5. **Explicit blast-radius control.** Keys and grants are rotatable/revocable; bans reject credentials immediately; archived/disabled seats can't be occupied.
6. **Capability-scoped, need-to-know.** A seat may do only what its role's capabilities allow (comms, tools, declared resource scopes, visibility) and may _see_ only what it needs. Admins see all; non-admins get a viewer-scoped projection.

## Capabilities & visibility (authorization beyond credentials)

Credentials decide _who_; capabilities decide _what_ and _what's visible_. Both tiers are enforced server-side on every operation that flows through musterd.

- **Capabilities** attach to a Role (team default) and may be **narrowed per seat** (never widened). v0.2 fixed set: `can_message` (scope), `visibility_level`, `tool_allowlist`, `declared_resource_scopes`, `can_flag_urgent`, `can_observe`, `is_admin`. (Custom RBAC engines are roadmap — a tar pit to avoid early.)
- **Need-to-know visibility:** roster/info endpoints return a **viewer-scoped projection**. Non-admins never see credentials, grants, audit, team policy, or other roles' charters — only teammate handles, presence, and acts addressed to them.
  > **Shipped (ADR 128/136).** The server scopes both `GET /teams/:slug/messages` and the `team-all` firehose to a regular Member's party-to-the-Act traffic: sent, received, and Team-broadcast Acts. Admins and full-grade observers retain full visibility. A public watch-link observer sees Team-broadcast traffic only. Watch links are not anonymous: they still expose roster handles and Presence.
- **Enforce vs declare:** musterd **enforces** what flows through it (messaging, notification, visibility, governance, claims) and **declares** external scopes (repo/dir/tool) as the source of truth; filesystem/tool enforcement is delegated to the harness today, a sandbox on the roadmap. We never claim to enforce what we don't control (Principle 4).

## `urgent` as a guarded capability

`urgent` is the only signal that pierces a human's `away` (notification model in `membership-model.md`), so it is scarce by design, not by etiquette:

- Gated by the **`can_flag_urgent`** capability (admin-granted; not default).
- Every `urgent` ping **carries a required reason** and is **audited / admin-visible**.
- Recipients can mark an `urgent` **"wasn't urgent"**, recorded against the sender; repeated abuse costs the capability.
- (Roadmap) per-sender rate-limiting.

## Assets

- **Identities (seats)** and the ability to act _as_ them (send acts, do work, be trusted by teammates).
- **Credentials:** agent keys, grants, human credentials, admin capability.
- **The message log** (could contain sensitive work content) and the **audit log**.
- **The daemon** itself (local process; controls all of the above).

## Trust boundaries

- **The daemon** is the trusted core; it holds the DB and enforces all authz.
- **Harness configs** (`.cursor/mcp.json`, `~/.claude.json` project scope, env) hold secrets and sit **outside** the daemon's control — treat them as the weakest link.
- **The local machine / user account** is trusted in v0.1 (local-first). Shared/remote teams widen the boundary; that's why grants exist.

## Threats & mitigations

| Threat                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leaked bootstrap credential** (e.g. committed `.cursor/mcp.json`) lets an attacker connect | Its server-held scope limits it to one seat, role pool, or residency host, and a claim still needs a **grant** (live approval by default). It is independently expirable and revocable. `.gitignore` secret-bearing configs (`.musterd/binding.json` is gitignored); `init` warns. The committed launch spec `.musterd/workspace.json` (ADR 080) is **secret-free by construction** — `saveWorkspaceSpec` parse-strips `agent_key`/`grant`, and a test asserts no `mskey_`/`msgr_` reaches it. |
| **Leaked/over-broad grant**                                                       | Grants are **seat/role-scoped, expiring, single-use-optional, revocable**, and audited. A leaked grant exposes **one** seat for a bounded time, and can be revoked.                                                                                                                                                                                                                                                                                                                                                          |
| **Impersonation / multiple minds as one identity**                                | **Single-active** per seat + refuse-on-collision: a second claim is rejected, never a silent shadow occupant.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Stolen human credential**                                                       | Scoped to one human seat; **ban** rejects it immediately; admin can rotate. Admin capability is separate from the credential's base rights.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Privilege escalation** (agent tries to govern)                                  | Governance routes are **admin-only**; agent keys/grants carry no governance rights. Enforced + tested as least-privilege checks.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Stale authority** (member left / task done)                                     | Grants expire; grace window bounds held seats; archive/disable/ban remove access; audit shows who had what when.                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Secret disclosure via logs/errors**                                             | Hash-at-rest; logger redaction; no secrets in error messages or `--json` output.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Confused-deputy via pre-issued grants**                                         | Pre-issued grants are **off by default**, enabled per-team only by an admin, and every pre-issued grant is itself audited and revocable.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Tampering with history**                                                        | Message log is append-only; audit log is append-only and admin-readable.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Credential & grant lifecycle

- **Agent bootstrap credential:** an admin mints an independently revocable `mskey_` for one seat, declared role pool, or residency host. The plaintext is shown once; only its hash and redacted inventory metadata remain. Rotation is staged: mint a successor, distribute and verify it, then revoke the predecessor. The Team-wide key minted by `team create` remains only as a marked compatibility credential.
- **Agent-seat credential + session lease:** an authorized agent claim mints a rotatable, self-identifying `msac_` credential once and a fresh short-lived `msls_` lease on each occupancy. Routine agent HTTP requires both. Reclaim, supersession, release, ban, archive, rotation, and expiry invalidate the lease.
- **Grant:** issued by an admin (live on a request, or pre-issued when policy allows). Carries `scope` (seat|role), `target`, `lifetime`, optional `single_use`. **At live approval the admin picks the lifetime: just-once (single-use), N-hours (TTL), or until-revoke (standing).** This keeps "no silent grant" while sparing the operator a re-prompt on every reconnect. Verified on claim; recorded on use; `revoke` is immediate. Pre-issued grants (team opt-in) follow the same shape but are written into a config before any claim.
- **Human credential:** minted when a human seat is created/joined; rotatable; rejected when the seat is banned.
- **Admin:** capability flag on a human seat; creator by default; (multi-admin delegation is roadmap).

## Defaults vs opt-ins (the security posture knobs)

| Knob                | Secure default                           | Opt-in                                           |
| ------------------- | ---------------------------------------- | ------------------------------------------------ |
| Claim authorization | **live admin approval** per claim        | team policy `allow_pre_issued_grants` (admin)    |
| Session activation  | **dormant** (tools available, no occupy) | `MUSTERD_AUTOCLAIM` per harness                  |
| Observers           | **off** unless role permits              | admin grants observer-permitting role to a human |
| Grant lifetime      | short, expiring                          | admin sets longer TTL for a stable harness       |

## Operational guidance (v1)

- `.gitignore` every secret-bearing config: `.cursor/mcp.json`, any file holding `MUSTERD_AGENT_KEY`/`MUSTERD_GRANT`, and `~/.musterd/config.json` is chmod 600.
- `init` shows a one-line warning when it writes a secret to a repo-local file, and offers to add it to `.gitignore`.
- The daemon binds to `127.0.0.1` by default; exposing it beyond localhost is an explicit, guarded step. The daemon **refuses** a non-loopback bind in plaintext (ADR 040): it requires native TLS (`MUSTERD_TLS_CERT` + `MUSTERD_TLS_KEY`, serving `wss://`) **or** `--insecure-trust-proxy` acknowledging a TLS-terminating proxy/overlay in front. The WS upgrade enforces Origin/Host checks (cross-site / DNS-rebinding defense), `serve` logs the effective host + scheme, and the resilience timeouts are env-tunable for WAN teams. The full networking substrate for cross-machine/cross-network teams — daemon reachability, NAT, overlay-vs-hosted-relay topologies, and the secured off-loopback bind these credentials ride on — is designed in `deployment-topology.md` (decided in ADR 039); the secured bind itself is ADR 040. The near-term zero-code path is an overlay (`../guides/cross-network-overlay.md`).

## Out of scope (roadmap, named so we don't design into a corner)

Automatic/scheduled credential rotation; mTLS / authenticated remote transport; encryption-at-rest for the DB; multi-admin policy & delegation; signed audit log; rate-limiting / anomaly detection on claims; secret storage via OS keychain instead of plaintext config files.
