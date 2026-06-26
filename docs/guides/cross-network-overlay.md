# Run a musterd team across machines (Tailscale / WireGuard overlay)

> **Audience:** the operator standing up a team whose members are on different machines and different
> networks (home / office / cloud, behind NAT). **Effort:** minutes, **zero musterd code** — you stand
> the team on an overlay network and point every member at the daemon's overlay address.
>
> This is **Topology B** from `../design/deployment-topology.md` (§3), the decided near-term answer for
> cross-network teams (ADR 039). For the *why* — the one-team-one-daemon invariant and why the overlay
> does the networking musterd deliberately doesn't — read that design doc; this guide is the recipe.

## The idea in one paragraph

A musterd Team is served by **exactly one daemon** (ADR 039). Every member — CLI or MCP adapter — is an
**outbound** WebSocket client of that daemon; the daemon is the only thing that listens. So making a
cross-network team work is purely an **addressing** problem: give the daemon one address every member
can reach. A private overlay (Tailscale, WireGuard, Cloudflare Tunnel) does exactly that — it hands the
daemon's machine a stable address reachable across NATs, and the overlay itself supplies the encryption
and mutual authentication. musterd writes none of that networking (Principle 4: don't reinvent
WireGuard). You run the daemon on the overlay; members set `MUSTERD_SERVER` to its overlay address.

## What you need

- An overlay that gives the daemon's machine a stable address every member can reach. Examples:
  - **Tailscale** — a tailnet IP (`100.x.y.z`) or MagicDNS name (`daemon-box.tailnet.ts.net`).
  - **WireGuard** — the daemon peer's tunnel IP (e.g. `10.0.0.1`).
  - **Cloudflare Tunnel / ngrok** — a hostname that tunnels to the daemon's port.
- One always-on-ish machine to host the daemon (a laptop works for a session; a small VM is steadier).
- Every member joined to the same overlay.

## Steps

### 1. Pick the daemon's machine and join it to the overlay

Choose one machine to run the daemon. Join it to your overlay and note its **overlay address** — the
Tailscale MagicDNS name or tailnet IP, the WireGuard tunnel IP, etc. Call it `DAEMON_ADDR`.

### 2. Run the daemon, bound so the overlay can reach it

The daemon defaults to `127.0.0.1`, which only the daemon's own machine can reach. For the overlay to
reach it, bind it to the overlay interface's address (preferred) — not `0.0.0.0`:

```bash
# On the daemon's machine. Bind to the overlay address so only the overlay can reach it.
musterd serve --host "$DAEMON_ADDR"
# or: MUSTERD_HOST="$DAEMON_ADDR" musterd serve
```

> **⚠️ Do not bind `0.0.0.0` in plaintext.** `0.0.0.0` exposes the daemon on **every** interface,
> including any public one — in plaintext, with no transport auth of its own. Bind the **specific
> overlay address**, and let the overlay be the only network that can reach the port. (musterd already
> *refuses* a non-loopback bind without TLS or an explicit proxy acknowledgement — `assertBindSecurity`,
> ADR 040 / `../design/deployment-topology.md` §5: configure `MUSTERD_TLS_CERT`/`KEY` or pass
> `--insecure-trust-proxy`. Binding the specific overlay address is still the recommendation.)

If your overlay terminates encryption for you (Tailscale, WireGuard, a TLS tunnel), the link between
members and the daemon is already encrypted and mutually authenticated by the overlay — that is exactly
what lets musterd carry no TLS of its own in this topology.

### 3. Point every member at the daemon's overlay address

On **each** member's machine (already joined to the overlay), set `MUSTERD_SERVER` to the daemon's
overlay address and port (default `4849`):

```bash
export MUSTERD_SERVER="http://$DAEMON_ADDR:4849"
```

That env var overrides the client's default of `http://localhost:4849`; the CLI derives the WebSocket
URL from it automatically (`http://…` → `ws://…`, and `https://…` → `wss://…`). For the **MCP adapter**,
set `MUSTERD_SERVER` the same way in the harness config that launches the adapter (`.cursor/mcp.json`,
Claude Code / Codex MCP config) so the agent's surface dials the same daemon.

Everything else is unchanged: `musterd status`, `team create` / `join`, `send`, `inbox`, claims and
presence all work exactly as on localhost — they're just talking to a daemon that happens to live across
the overlay.

## Verify

Run this checklist before you trust the team:

1. **Reachability** — from a member's machine, confirm the daemon's `host:port` is reachable over the
   overlay:
   ```bash
   curl "http://$DAEMON_ADDR:4849/health"   # → {"ok":true,"v":...,"db":...,"schema":...}
   ```
   `/health` needs no token; a clean JSON response means the overlay path works end to end.
2. **One daemon, one db** — the `db` field in `/health` is the database the daemon is actually serving.
   Every member hitting the *same* `DAEMON_ADDR` is on the *same* team store. (A daemon accidentally
   serving the wrong db reads as "everyone offline" — ADR 016.)
3. **Presence** — have two members on two machines run `musterd status`; each should see the other in the
   roster once both are attached.
4. **Drop tolerance** — the durable inbox covers WAN drops: a member offline during a partition re-reads
   everything missed on reconnect via its inbox cursor (at-least-once; `../architecture/03-server.md`).
   You can sanity-check this by sending to a member who is briefly offline and confirming the message
   appears in their `inbox` when they return. No message is lost to a dropped link.

## What this guide is *not*

- **Not `0.0.0.0` in plaintext on a public network.** See the warning in step 2. If you have no overlay
  and must bind a routable address directly, you want **Topology A** (secured off-loopback bind with TLS)
  — `../design/deployment-topology.md` §5 — not this guide.
- **Not federation.** One team is still one daemon; this guide makes that one daemon reachable, it does
  not join teams together (`../design/deployment-topology.md` §8).
- **Not a hosted service.** Topology C (a musterd-operated relay where neither side needs a reachable
  address) is named-but-unscheduled (ADR 039). Until it exists, an overlay is the zero-code way to get a
  cross-network team today.
