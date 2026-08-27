# Security — reporting and the v0.2 boundary

Musterd takes security seriously and tries to be honest about what it does and does not defend against today. This file is the reporting guide and the **honest v0.2 boundary statement**. The full threat model and the v0.3 hardening design live in [`docs/design/security.md`](docs/design/security.md); the wire-level governance that activates when the daemon leaves localhost is [`SPEC.md` Appendix A](SPEC.md).

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** (preferred): [Security → Report a vulnerability](https://github.com/SandRiseStudio/musterd/security/advisories/new). That creates a private advisory visible only to maintainers until a fix ships.

If you cannot use it, open a regular issue with the label `security` and **do not include exploit details** in the public thread — we will move it private.

We aim to acknowledge within 72 hours and to ship a fix or a mitigated release with a `SECURITY.md` entry. For issues that are not vulnerabilities (hardening ideas, defense-in-depth), a normal issue or PR is fine.

## Supported versions

Musterd is pre-1.0 and ships as `@musterd/*` 0.4.x; the milestone names the trust model, not the release. Security fixes are provided on `main` and the latest published `@musterd/*` on npm. If you are on an older checkout, `musterd service refresh` after merging `main` is the update path.

| Version                              | Supported                    |
| ------------------------------------ | ---------------------------- |
| `main` / `@musterd/*@latest` (0.4.x) | Yes                          |
| Older tags / checkouts               | No — please update to `main` |

## v0.2 — what this is and what it assumes

v0.2 is **local-first, single-user, single-admin, and `127.0.0.1`-bound by default**. Its trust boundary is **the local machine and the local user account**. Within that boundary the minimal trust model holds; outside it the v0.3 governance model (seats/roles, agent key + grants, approval lane, capabilities, audit) is designed but **not built or enforced** — see [`docs/design/security.md`](docs/design/security.md) Status note and [`docs/design/membership-model.md`](docs/design/membership-model.md).

Treat v0.2 as you would a local dev tool on your own machine — not as a multi-tenant or internet-exposed service.

## What v0.2 _does_ defend

Within the local-machine boundary, v0.2 provides:

- **Scoped, hashed secrets at rest.** Agent keys (`mskey_`), grants (`msgr_`), and human credentials (`mscr_`) are stored only as `sha256` server-side and `chmod 600` client-side. Plaintexts are shown once and never logged (the structured logger redacts them).
- **Explicit activation.** Registering the MCP adapter does not claim a seat — a session is dormant until it explicitly calls `team_join` (or an equivalent `claim`).
- **Single-active per agent seat, kind-scoped (ADR 042).** An agent Member can hold at most one live Presence at a time; a second session displaces the first (`superseded`, newest-wins) with a short reclaim grace (45s). Humans fan out across surfaces by design — no displacement.
- **Self-reported activity, not inferred presence.** `working` is set only by a `status_update` the seat sent, not guessed by the server; stale `working` renders as `working: x · Nm`.
- **Local-only bind by default, and a guarded off-loopback bind.** The daemon binds to `127.0.0.1` unless you explicitly configure TLS or `--insecure-trust-proxy` (ADR 040). A non-loopback plaintext bind is **refused**. Native TLS serves `wss://`; the WS upgrade enforces Origin/Host checks (cross-site / DNS-rebinding defense). `serve` logs the effective host and scheme.
- **Secret hygiene.** `.musterd/binding.json` (secrets-bearing) is gitignored and `chmod 600`; the committable `.musterd/workspace.json` (ADR 080) is stripped of `agent_key`/`grant` by construction and tested; `init` warns when it writes a secret to a repo-local file.
- **Hash-at-rest, no secret in errors/telemetry.** Errors, `--json` output, and OTel spans never carry `mskey_`/`msgr_`/`mscr_` bodies.

## What v0.2 _does not_ defend — honest gaps before strangers run it

Do not rely on v0.2 for:

- **Need-to-know message confidentiality within a team.** Any Member with `can_observe` (generalist default `true`) can read **every** envelope on the team via `GET /teams/:slug/messages` or `subscribe team-all`, including DMs between two other Members. Only roster/capability projection is viewer-scoped today; message-content scoping is a **hard prerequisite for the v0.3 shared-team hardening** and for the insight layer (ADR 048/050/084) — see [`docs/design/security.md`](docs/design/security.md) Known gap (2026-07-02). Treat the team message log as shared among its Members.
- **Encryption at rest.** `~/.musterd/musterd.db` (SQLite) and logs are unencrypted on disk; an attacker who can read the local user account can read them.
- **OS keychain or hardware-backed secret storage.** Secrets live in plaintext files under `~/.musterd` and harness configs (`.cursor/mcp.json`, `~/.claude.json` project scope, env), `chmod 600` but not keychain-backed. Those harness configs sit **outside** the daemon's control and are the weakest link.
- **Per-seat or rotating agent keys, mTLS, or network-level authentication beyond the bearer token.** Team agent key is per-team, long-lived until rotated (`agent-key rotate`), and bearer.
- **Multi-admin delegation, signed audit log, or rate-limiting / anomaly detection on claims.** Single admin (creator default) and best-effort audit today.
- **Sandboxed enforcement of declared scopes.** Roles declare repo/dir/tool scopes (ADR 026, two universes); musterd enforces messaging/visibility/governance and **declares** external scopes for the harness, which enforces them. Filesystem/tool escapes are delegated to the harness today.
- **Remote or internet-facing deployment without the v0.3 hardening.** Exposing the daemon beyond loopback before the shared-teams governance, recipient-scoped firehose, and deployment topology hardening (ADRs 039/040/325) is at your own risk; the overlay guide is the near-term zero-code path.

If you need any of the above, wait for the v0.3 shared-team governance set or help build it — see `ROADMAP.md` and the ADRs. Reporting a gap you hit in practice is welcome, even when it is a known road-mapped gap — it helps prioritize.

## Credentials and hygiene

- **`.gitignore` every secret-bearing config:** `.cursor/mcp.json`, any file holding `MUSTERD_AGENT_KEY`/`MUSTERD_GRANT`, and `~/.musterd/config.json`. `init` offers to add them.
- **Do not commit** `.musterd/binding.json`. The committed `.musterd/workspace.json` is safe to commit (secret-free by test).
- **Rotate after exposure:** `musterd team agent-key rotate` (agent key) and `revoke` / re-issue grants. A banned/disabled seat's credential is rejected immediately.
- **Keep the daemon local** unless you have read `docs/design/deployment-topology.md` and `docs/guides/cross-network-overlay.md` and understand the TLS/proxy requirement.

## Telemetry and privacy

Telemetry is **off by default**; OTel starts only when you set `OTEL_EXPORTER_OTLP_ENDPOINT` (or variants). Message bodies are never telemetry. See [`PRIVACY.md`](PRIVACY.md).

## Coordinated disclosure

We will credit you in the advisory unless you prefer not to be named. Please give us reasonable time to fix and release before public disclosure.
