# 040 — secured off-loopback bind: refuse plaintext beyond loopback (Topology A)

- Status: accepted
- Date: 2026-06-23

## Context

ADR 039 decided the cross-network topology framework: Topology A is the next musterd-side step — a
configurable off-loopback bind that *requires* transport security. The server already accepts a bind
host (`MUSTERD_HOST`, default `127.0.0.1`) and calls `http.listen(port, host)`, but it has **no TLS
guard**: it will bind any host — including `0.0.0.0` — in **plaintext** today. The WS upgrade has no
Origin/Host check, the resilience constants (`HEARTBEAT_INTERVAL_MS`, `PRESENCE_TIMEOUT_MS`,
`RECLAIM_GRACE_MS`, `REAPER_INTERVAL_MS`) are hardcoded, and `serve` logs a hardcoded `ws://` scheme.

This is the "secure by default" guard (Principle 7) that makes Topology A possible and makes accidental
WAN exposure impossible. It builds the *transport substrate* the v0.3 credential model will later ride
on — it does **not** build the credentialed remote join (agent key + grant + human credential), which
stays out of scope (`membership-model.md`, ADR 007).

## Problem

Make widening the bind a deliberate, guarded step that cannot happen by accident, without changing the
loopback default behavior, without a new runtime dependency, and without a protocol/SPEC change. Four
sub-decisions had to be made (deviation protocol), recorded here.

## Decision

**1. Native TLS *and* trust-proxy — support both (§10 open question).** The guard is satisfiable two
ways, so it never forces a particular deployment:
- **Native in-process TLS** — `MUSTERD_TLS_CERT` + `MUSTERD_TLS_KEY` (or `--tls-cert` / `--tls-key`)
  point at a cert/key pair; the daemon serves over Node's built-in `https`, clients use `wss://`. Both
  must be set or neither (a half-configured TLS is a startup error). No new dependency — Node `https`/
  `tls`/`fs` only (hard rule #6).
- **`--insecure-trust-proxy`** (`MUSTERD_INSECURE_TRUST_PROXY=1`) — an explicit acknowledgement that a
  TLS-terminating reverse proxy or overlay sits in front, so the daemon may speak plaintext `ws` to
  that local hop. This is the common overlay/proxy case (Topology B/A).

**2. The guard predicate.** "Loopback" = `localhost`, `::1`, and the `127.0.0.0/8` block. The daemon
**refuses to bind** when: the host is **non-loopback** AND **no** TLS is configured AND
`--insecure-trust-proxy` is **not** set. Wildcard binds (`0.0.0.0`, `::`) are non-loopback, so they are
covered by the guard. The refusal is a startup `Error` (fail-fast in `createServer`, before the db is
opened), in the helpful-refusal style of ADR 036 — it names the host, says why, and lists the three
ways forward (configure TLS, pass `--insecure-trust-proxy`, or use an overlay with a pointer to
`docs/guides/cross-network-overlay.md`). It is **not** a protocol error code — this never reaches the
wire.

**3. Origin / Host checks on the WS upgrade — always on.** DNS-rebinding can target a loopback daemon,
so the check runs unconditionally, not only off-loopback:
- **Origin:** legitimate musterd clients (CLI, MCP adapter via the `ws` package) send **no** `Origin`
  header; only a browser does. So a present `Origin` is **rejected** unless explicitly allowlisted via
  `MUSTERD_ALLOWED_ORIGINS`. This blunts a malicious web page driving the daemon (cross-site /
  DNS-rebinding).
- **Host:** the `Host` header's hostname must be loopback, the bound host, or in
  `MUSTERD_ALLOWED_HOSTS`; otherwise the upgrade is `403`-ed. (A wildcard bind behind a proxy therefore
  requires the operator to set `MUSTERD_ALLOWED_HOSTS` — safe by default.) A missing `Host` is rejected.

The check is a **pure function** (`checkUpgrade`) for unit-testability; the upgrade handler just calls
it and rejects with `403` on failure. HTTP routes are unaffected — everything but `/health` and
`POST /teams` is already Bearer-token-gated, so the cross-site lever is the unauthenticated WS upgrade.

**4. Tunable resilience constants — config/env-overridable, defaults unchanged (§6/§10).** The four
timeout/grace constants become overridable via `MUSTERD_HEARTBEAT_INTERVAL_MS`,
`MUSTERD_PRESENCE_TIMEOUT_MS`, `MUSTERD_REAPER_INTERVAL_MS`, `MUSTERD_RECLAIM_GRACE_MS`, keeping today's
values (15s / 45s / 15s / 45s) as defaults — **no behavior change out of the box**, but a WAN team can
loosen them. The newest-wins self-heal (ADR 017) is tested at WAN-like timing to confirm it behaves.

**5. No SPEC / protocol-version bump (§ Decision 5 of the handoff).** This is a transport/deployment
rule — bind host, scheme, upgrade headers, timeout tuning — not an envelope / act / wire-format change.
It lives in `security.md` (Principle 7 / the off-loopback line) and `docs/architecture/03-server.md`,
updated in the same commit (living-doc rule). The protocol is **not** versioned for a deployment guard.

All new config inputs (timeout numbers, TLS paths, trust-proxy/allowlist values) are zod-validated at
the boundary (hard rule #4); cert/key contents and any secret are never logged (hard rule #5).

## Consequences

- **Loopback default is unchanged.** `musterd serve` with no flags binds `127.0.0.1` plaintext exactly
  as before; the guard, the upgrade check (no Origin from CLI/MCP clients, loopback Host), and the
  default timeouts are all transparent to it. Existing tests keep passing.
- **Accidental WAN exposure is now impossible:** a non-loopback bind without TLS/proxy-ack fails to
  start with guidance, rather than silently serving plaintext to the world.
- **`serve` logs the effective host + scheme** (`ws://127.0.0.1:4849` vs `wss://…`, and a note when a
  TLS-terminating proxy is trusted), extending the ADR 016 "what is this daemon serving?" posture so
  exposure is answerable.
- **Topology A is now reachable**; the credentialed remote join still isn't built — this is the channel
  the v0.3 credentials will ride (ADR 039 / 007). Out of scope and untouched: mTLS client certs,
  encryption-at-rest, per-seat keys, Topology C (`security.md` roadmap list).
- Cross-references: ADR 039 (topology framework), ADR 016 (daemon diagnostics), ADR 017 (newest-wins),
  `docs/design/deployment-topology.md` §5–§6, `docs/design/security.md`.
