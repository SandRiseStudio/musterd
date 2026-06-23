# 034 — `musterd claim --for <code>` brings a running pending session online (resolution sidecar)

- Status: accepted
- Date: 2026-06-23

## Context

ADR 033 made pending presence client-side and delivered a claimed identity **via the workspace
binding** — so an external `musterd claim` set the folder's seat, and a pending adapter picked it up
on its **next launch** or via an in-session `team_join`. It explicitly deferred *live* delivery into
an **already-running** unclaimed adapter as a reserved follow-up: the marker schema + write/clear path
existed, but nothing closed the loop from a human's `musterd claim --for <code>` to a live session
going online without a relaunch. ROADMAP carried it as a small, additive enhancement.

## Problem

The binding is the **folder-global** default — it can't target *one specific* pending session, which
is exactly what `--for <code>` means (the recipe's deterministic disambiguation when several sessions
wait). And the running adapter holds **no token** (it's pending), so any live-delivery channel must
carry the token to it. A folder-global, tokenless binding can't be that channel.

## Decision

Add a **per-code resolution sidecar** the adapter watches for.

- **CLI.** When `musterd claim` consumes a pending marker (either `--for <code>`, or the sole waiting
  marker auto-picked), in addition to writing the binding it drops
  `.musterd/pending/<code>.resolved.json = { member, token }` (0600) and removes the discovery marker.
  The resolution is keyed by the same `code` the adapter announced, so it targets exactly that session.
- **Adapter.** A pending session starts a **resolution watcher** (`startResolutionWatcher`) alongside
  its pending marker: a polled check (`readAndConsumeResolution`) for *its own* `<code>.resolved.json`.
  On finding one it **reads then immediately deletes** the file (and its marker), `adoptIdentity`s the
  seat (bind identity → persist binding → `join()`), and stops watching. The poll interval is unref'd
  (never holds the process open) and the watcher stops on shutdown or once the session is claimed by
  any path (an in-session `team_join` racing the watcher is a clean no-op — `adoptIdentity` returns
  early when already joined).

**Why a token-bearing sidecar, and why that's acceptable.** The token is unavoidable — a pending
session has none and must receive one to authenticate. The exposure is bounded the way the rest of the
local model is (ADR 032's unauthenticated mint, ADR 007's localhost trust): the file is **0600**, and
its on-disk life is **one poll interval** (the adapter deletes it on pickup, even when malformed). It
lives beside `.musterd/binding.json`, which already holds a long-lived token under the same init
gitignore nudge. Polling (not `fs.watch`) is deliberate: portable across platforms and trivially
testable without filesystem-event timing.

**Scope held.** This does **not** change the ADR 033 line that the *binding* is the durable identity
channel — the sidecar is an ephemeral live-delivery overlay on top of it (the binding is still written,
so a missed/disabled watcher degrades cleanly to next-launch pickup). It remains the **local** floor;
the governed off-localhost claim (A.3) is unaffected. No wire change, no SPEC bump.

## Consequences

- The loop closes: a human runs `musterd claim Ada --for AB12` and the waiting Cursor/Claude Code
  session goes online as Ada **without a relaunch** — the L2 universal floor now reaches live sessions,
  not just the next launch. `--json` reports `live: true`.
- Best-effort throughout: a failed sidecar write, a watcher that never runs (claimed-at-startup
  sessions don't start one), or a malformed file all degrade to the ADR-033 behavior (pick the seat up
  on next launch / `team_join`). Nothing new can wedge a session.
- New surface is small + additive: `ResolvedSession` schema + `RESOLVED_SUFFIX` (`@musterd/protocol`),
  `writeResolution` (cli), `readAndConsumeResolution` + `adoptIdentity` + `startResolutionWatcher`
  (mcp). Extends ADR 033; supersedes nothing. Updates: `provisioning-recipe.md` §6, `05-mcp.md`,
  `ROADMAP.md` (follow-up → built).
