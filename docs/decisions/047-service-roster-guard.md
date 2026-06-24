# 047 — Service guardrails: don't bounce a shared daemon out from under a live teammate

- Status: proposed
- Date: 2026-06-24

## Context

ADR 045 gave the daemon a real lifecycle (`musterd service install|start|stop|restart|…`). The
2026-06-24 dogfood immediately exposed its sharp edge: the agent restarted the **shared** daemon three
times while a teammate (Clyde) held a live session — the server logs show `reap_offline` + a fresh
`ws_hello` each time — with no in-band heads-up. The agent's own earlier status_update even said "didn't
restart the shared daemon to avoid disrupting the team," then it did exactly that. `stop`/`restart` are
destructive to *everyone connected*, but nothing surfaces who that is.

## Problem

Make the disruptive `service` verbs **refuse by default** when other members have live sessions, so a
restart is a conscious choice rather than a silent teammate-drop — **without** a new dependency, a wire
change beyond a diagnostic field, or making the common (nobody-connected) case any harder.

## Decision (proposed)

`musterd service stop` and `service restart` **check for live sessions first** and refuse with guidance
unless `--force` is passed:

```
✗ 1 live session is connected to this daemon — restart will drop it.
  Give the team a heads-up (musterd send --to @team --act status_update "bouncing :4849, ~5s"),
  then re-run with --force.
```

When zero sessions are connected, the verbs behave exactly as today (no friction).

### 1. The signal: a live-session count on `/health`

The daemon hosts **all** teams in its db, so "who is connected" is cross-team — a per-team roster can't
answer it, and the CLI doesn't know every team. The daemon does. Extend the ADR 016 `/health` body with
a derived **`connections`** count (distinct members holding a live presence, across all teams), computed
from the presence store (the durable source), not the in-memory hub:

```
GET /health → { ok, v, db, schema, connections }
```

- **Count, not names.** `/health` is unauthenticated; a bare count ("1 live session") is enough for the
  guard and avoids broadening it into a cross-team member directory. Naming *who* is a deferred nicety
  (an authed diagnostic, or fold into the future dashboard), out of scope here.
- **Derived, additive.** A new read-only field; older clients ignore it (back-compatible). No protocol
  bump (HTTP diagnostics already evolve under ADR 016).

### 2. Scope: the destructive verbs only

The guard wraps `stop` and `restart`. `install`/`start` are setup/up intent — though note `install`'s
`kickstart` also bounces a running agent (open question below). `--force` is the universal override and is
implied for non-interactive/CI use.

### 3. Why not have the daemon refuse?

Keep the clean-core boundary (ADR 045): the daemon doesn't know about launchd or "should I let you stop
me." The *CLI* owns the guard — it reads the daemon's honest `connections` count and decides. Same split
as the rest of `service`.

## Implementation plan

- **`packages/server/src/store/presence.ts`** — add `countLivePresences(db, timeoutMs): number` (distinct
  `member_id` with a fresh/held presence across all teams). Pure-ish store query; unit-tested.
- **`packages/server/src/transport/http.ts`** — add `connections: countLivePresences(ctx.db, timeout)` to
  the `/health` payload.
- **`packages/server/src/index.ts` / `RunningServer`** — no change needed; `/health` already exists.
- **`packages/cli/src/client.ts`** — extend `health()`'s return type with `connections?: number`.
- **`packages/cli/src/commands/service.ts`** — add `guardLiveSessions(ctx, force)`: fetch `/health`
  (best-effort; if unreachable, *allow* — can't be disrupting sessions on a daemon that's already down);
  if `connections > 0 && !force` throw `CliError` with the message above. Call it at the top of the
  `stop` and `restart` arms. Make the health fetch injectable (extend the existing `deps` seam:
  `deps.health?: () => Promise<{ connections?: number }>`) so it's testable without a live daemon.
- **`packages/cli/src/args.ts`** — ensure `force` is in `BOOLEAN_FLAGS` (used here and already by
  reset/uninstall).
- **`packages/cli/src/bin.ts`** — help text: add `[--force]` to the `service` usage line.
- **Tests:**
  - server: `countLivePresences` counts live, ignores offline/expired; `/health` includes `connections`.
  - cli: `restart`/`stop` with `connections>0` and no `--force` → refuses (exit 1); with `--force` →
    proceeds; with `connections:0` → proceeds; health-unreachable → proceeds (fail-open, daemon's down).
- **Docs:** update `04-cli.md` (service prose: the guard + `--force`), `03-server.md` (`/health` gains
  `connections`); tick the roadmap item on landing.

## Open questions

- **Guard `install` too?** Re-`install` over a running agent `kickstart`s (bounces) it. Arguably the same
  hazard. Leaning: guard `install`'s *restart step* with the same `--force`, but allow the plist write +
  bootstrap (the no-op-if-unchanged case is harmless). Decide at build time.
- **Self-exclusion.** A CLI one-shot is not a WS presence, so the operator's own `service` call is never
  counted. But the operator may legitimately hold a separate `inbox --watch` session and still want to
  restart — the count includes them, and `--force` covers it. Naming-who would make this clearer (the
  deferred nicety).
- **Count freshness.** Uses the same presence timeout as the roster; a just-dropped session lingers for
  the reclaim grace, so the guard can warn about a session that's seconds from reaping. Acceptable — it
  errs toward caution, and `--force` is one keystroke.

## Consequences

- A shared daemon can't be silently bounced out from under teammates; disruption becomes a conscious,
  `--force`-gated act with a nudge to give a heads-up first.
- One additive, derived `/health` field; no wire/protocol change, no new dependency.
- Fail-open: if the daemon is unreachable the guard doesn't block (you can't disrupt sessions that aren't
  there), so it never wedges recovery.
- The clean-core boundary holds — the CLI guards; the daemon only reports.
