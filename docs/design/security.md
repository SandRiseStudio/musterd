# Security — threat model & principles

> **Status: DRAFT, paired with SPEC v0.3 (shared teams), deferred per ADR 007.** Security is a first-class principle (Principle 7: *secure by default*). The credential/grant/audit model below is the **v0.3** hardening for shared/remote teams and is **not** built in v0.2. Shipped v0.1 and the minimal v0.2 are local-first, single-user, single-admin, `127.0.0.1`-bound — their trust boundary is the local machine; this model activates when that boundary widens (the daemon stops being localhost-only). Principle 7 itself holds from day one — the v0.2 expression of it is simply: scoped per-member tokens, explicit activation, single-active, and secrets in chmod-600 / git-ignored configs.

## Principle 7 — secure by default

A musterd team protects identities and the work done under them. The defaults are the safe ones; convenience is an explicit, admin-made, auditable opt-in. No identity is occupied, and no privileged action taken, without an authenticated, authorized, recorded step.

Concretely:
1. **Least privilege.** An **agent key** authenticates a harness but cannot *be* an identity, cannot govern, and cannot occupy a seat alone. A **grant** authorizes exactly one seat/role, expires, and is revocable. Governance requires **admin**. No credential does more than its job.
2. **Authorize-then-occupy.** Occupying a seat needs an agent key **and** an admin-issued grant. **Default = live admin approval per claim.** Pre-issued grants are a per-team admin opt-in (`allow_pre_issued_grants`), never the default.
3. **Everything privileged is audited.** Grant issue/use/revoke, claim/occupy/release, account-status changes, key rotation, policy changes, and request decisions all append to an immutable audit log: `{ ts, actor, action, target, result }`.
4. **Secrets are hashes at rest, never logged.** Agent keys, grants, and human credentials are stored only as hashes server-side. They never appear in logs (structured logger redacts), errors, or telemetry.
5. **Explicit blast-radius control.** Keys and grants are rotatable/revocable; bans reject credentials immediately; archived/disabled seats can't be occupied.
6. **Capability-scoped, need-to-know.** A seat may do only what its role's capabilities allow (comms, tools, declared resource scopes, visibility) and may *see* only what it needs. Admins see all; non-admins get a viewer-scoped projection.

## Capabilities & visibility (authorization beyond credentials)

Credentials decide *who*; capabilities decide *what* and *what's visible*. Both tiers are enforced server-side on every operation that flows through musterd.

- **Capabilities** attach to a Role (team default) and may be **narrowed per seat** (never widened). v0.2 fixed set: `can_message` (scope), `visibility_level`, `tool_allowlist`, `declared_resource_scopes`, `can_flag_urgent`, `can_observe`, `is_admin`. (Custom RBAC engines are roadmap — a tar pit to avoid early.)
- **Need-to-know visibility:** roster/info endpoints return a **viewer-scoped projection**. Non-admins never see credentials, grants, audit, team policy, or other roles' charters — only teammate handles, presence, and acts addressed to them.
- **Enforce vs declare:** musterd **enforces** what flows through it (messaging, notification, visibility, governance, claims) and **declares** external scopes (repo/dir/tool) as the source of truth; filesystem/tool enforcement is delegated to the harness today, a sandbox on the roadmap. We never claim to enforce what we don't control (Principle 4).

## `urgent` as a guarded capability

`urgent` is the only signal that pierces a human's `away` (notification model in `membership-model.md`), so it is scarce by design, not by etiquette:
- Gated by the **`can_flag_urgent`** capability (admin-granted; not default).
- Every `urgent` ping **carries a required reason** and is **audited / admin-visible**.
- Recipients can mark an `urgent` **"wasn't urgent"**, recorded against the sender; repeated abuse costs the capability.
- (Roadmap) per-sender rate-limiting.

## Assets

- **Identities (seats)** and the ability to act *as* them (send acts, do work, be trusted by teammates).
- **Credentials:** agent keys, grants, human credentials, admin capability.
- **The message log** (could contain sensitive work content) and the **audit log**.
- **The daemon** itself (local process; controls all of the above).

## Trust boundaries

- **The daemon** is the trusted core; it holds the DB and enforces all authz.
- **Harness configs** (`.cursor/mcp.json`, `~/.claude.json` project scope, env) hold secrets and sit **outside** the daemon's control — treat them as the weakest link.
- **The local machine / user account** is trusted in v0.1 (local-first). Shared/remote teams widen the boundary; that's why grants exist.

## Threats & mitigations

| Threat | Mitigation |
|---|---|
| **Leaked agent key** (e.g. committed `.cursor/mcp.json`) lets an attacker connect | Key alone can't occupy a seat or govern — still needs a **grant** (live approval by default). Key is **rotatable**; rotation invalidates old harness configs. `.gitignore` secret-bearing configs; `init` warns. |
| **Leaked/over-broad grant** | Grants are **seat/role-scoped, expiring, single-use-optional, revocable**, and audited. A leaked grant exposes **one** seat for a bounded time, and can be revoked. |
| **Impersonation / multiple minds as one identity** | **Single-active** per seat + refuse-on-collision: a second claim is rejected, never a silent shadow occupant. |
| **Stolen human credential** | Scoped to one human seat; **ban** rejects it immediately; admin can rotate. Admin capability is separate from the credential's base rights. |
| **Privilege escalation** (agent tries to govern) | Governance routes are **admin-only**; agent keys/grants carry no governance rights. Enforced + tested as least-privilege checks. |
| **Stale authority** (member left / task done) | Grants expire; grace window bounds held seats; archive/disable/ban remove access; audit shows who had what when. |
| **Secret disclosure via logs/errors** | Hash-at-rest; logger redaction; no secrets in error messages or `--json` output. |
| **Confused-deputy via pre-issued grants** | Pre-issued grants are **off by default**, enabled per-team only by an admin, and every pre-issued grant is itself audited and revocable. |
| **Tampering with history** | Message log is append-only; audit log is append-only and admin-readable. |

## Credential & grant lifecycle

- **Agent key:** minted at `team create`; one per team in v0.2 (per-seat/rotating keys are roadmap). `agent-key rotate` invalidates the old key. Stored hashed.
- **Grant:** issued by an admin (live on a request, or pre-issued when policy allows). Carries `scope` (seat|role), `target`, `lifetime`, optional `single_use`. **At live approval the admin picks the lifetime: just-once (single-use), N-hours (TTL), or until-revoke (standing).** This keeps "no silent grant" while sparing the operator a re-prompt on every reconnect. Verified on claim; recorded on use; `revoke` is immediate. Pre-issued grants (team opt-in) follow the same shape but are written into a config before any claim.
- **Human credential:** minted when a human seat is created/joined; rotatable; rejected when the seat is banned.
- **Admin:** capability flag on a human seat; creator by default; (multi-admin delegation is roadmap).

## Defaults vs opt-ins (the security posture knobs)

| Knob | Secure default | Opt-in |
|---|---|---|
| Claim authorization | **live admin approval** per claim | team policy `allow_pre_issued_grants` (admin) |
| Session activation | **dormant** (tools available, no occupy) | `MUSTERD_AUTOCLAIM` per harness |
| Observers | **off** unless role permits | admin grants observer-permitting role to a human |
| Grant lifetime | short, expiring | admin sets longer TTL for a stable harness |

## Operational guidance (v1)

- `.gitignore` every secret-bearing config: `.cursor/mcp.json`, any file holding `MUSTERD_AGENT_KEY`/`MUSTERD_GRANT`, and `~/.musterd/config.json` is chmod 600.
- `init` shows a one-line warning when it writes a secret to a repo-local file, and offers to add it to `.gitignore`.
- The daemon binds to `127.0.0.1` by default; exposing it beyond localhost is an explicit, documented step that SHOULD require transport security (roadmap: TLS/authn for remote). The full networking substrate for cross-machine/cross-network teams — daemon reachability, NAT, overlay-vs-hosted-relay topologies, and the secured off-loopback bind these credentials ride on — is designed in `deployment-topology.md`.

## Out of scope (roadmap, named so we don't design into a corner)

Per-seat / rotating agent keys; mTLS / authenticated remote transport; encryption-at-rest for the DB; multi-admin policy & delegation; signed audit log; rate-limiting / anomaly detection on claims; secret storage via OS keychain instead of plaintext config files.
