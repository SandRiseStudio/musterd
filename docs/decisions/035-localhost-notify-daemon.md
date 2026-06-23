# 035 — `musterd notify`: the localhost notification down-payment

- Status: accepted
- Date: 2026-06-23

## Context

ADR 024 wired the **recipient-side** half of the Co-Gym notification finding
(`research-foundation.md`; arXiv:2412.15701 — a notification protocol more than doubles the
collaborative win rate, **30% → 70%**). It solved two postures cheaply: **(A) the human is watching**
`inbox --watch` but the signal is buried — fixed with the `⚑ ACTION NEEDED` banner + terminal bell;
and **(B) the human comes back** — fixed with the `status` comeback summary off the durable cursor.

ADR 024 deliberately left a hole, and named it: **(B′) the human is away with _nothing open_.** The
only durable human attachment was `inbox --watch` — the very thing an away human isn't running — so
there was nothing resident to push from. ADR 024 deferred OS-native push on two grounds: it needs a
resident human-side process that didn't exist, and the tempting shortcut of *firing it from the
daemon* would couple the clean coordination core to the host desktop and break under the remote
topology (`deployment-topology.md`).

This ADR closes (B′) with the **minimal nudge** — the localhost down-payment on the v0.3 governed
**Loud** tier (`SPEC.md` A.6a, `membership-model.md` "The human's day"). It is explicitly **not** the
governed model: no away/dnd/off-hours breakthrough, no scarce `urgent` capability, no per-recipient
delivery policy, no seat/grant coupling. One flat rule — _a directed act to a human who isn't
watching fires an OS notification_ — and the v0.3 tier names are left as the obvious extension seam.

## Problem

Reach an away human's laptop when an act that needs them lands, **without** (a) a daemon→desktop
coupling, (b) a new wire field / SPEC bump, (c) a new runtime dependency, or (d) re-nagging.

Three sub-decisions, each load-bearing:

1. **Delivery mechanism + the resident-process question.**
2. **Where the trigger fires** — client-side vs. server/daemon-side.
3. **What "not watching / unreachable" means** without the v0.3 availability axis.

## Decision

A new opt-in CLI command, **`musterd notify`** — a *client-side*, *headless* notifier the human
leaves running (login shell / `launchd` / `&`). It is not a watch pane to stare at; it is the
delivery arm ADR 024 said didn't exist yet. It rides only primitives that already exist.

### 1. Delivery mechanism — shell out to the OS notifier; resident, but client-side

Notifications fire by **shelling out** to the platform notifier — `osascript` on macOS (mirroring the
ADR 031 Codex/osascript precedent), `notify-send` on Linux — via `child_process.execFile`. Dynamic
strings (body, title) are passed to AppleScript as `on run argv` arguments, **never interpolated as
code**, so a teammate's message body can't inject AppleScript. On an unsupported platform or a missing
binary the call is a best-effort no-op (swallowed) — the ADR 024 comeback summary still serves that
human.

- **No new runtime dependency** (hard rule #6): `osascript`/`notify-send` are OS tools we invoke, not
  npm packages. Considered and rejected: `node-notifier` / `terminal-notifier` — a cross-platform
  dependency (and a vendored binary) for what two `execFile` lines already do; it would need an ADR to
  add and buys nothing on the localhost target.
- **Resident, but client-side.** ADR 024's virtue was "no resident process"; this ADR consciously
  adds one — but an *opt-in, human-side* one, decoupled from the daemon. The daemon stays a clean
  coordination core; the notifier runs wherever the human is, so the remote topology is untouched.
  This is the deliberate trade ADR 024 flagged: "no resident process" loses to "must reach a human
  with nothing open," but only for an opt-in process the user starts, never the daemon.

### 2. Where the trigger fires — client-side, off the cursor

`notify` **polls the existing inbox cursor** (`GET /teams/:slug/inbox?unread=1`), exactly as ADR 024's
`pendingActionSummary` does, and classifies with the **same pure `openActionNeeded`** predicate. It
does **not** open a WS presence: polling means (a) no wire change and **no SPEC bump** (it rides
existing HTTP, per ADR 024's precedent), and (b) it does not take the Member's single-active seat
(SPEC §single-active) — if `notify` attached a presence it would *supersede the human's real
`inbox --watch` pane*, the opposite of the goal. Server/daemon-side push was rejected for ADR 024's
reason: it couples the core to the desktop and would touch the wire.

De-dupe is two-layered, so it needs **no durable resident state to be correct**:
- **Correctness across runs** comes from the durable cursor: an item is only a candidate while
  unread-and-open; once the human reads their inbox the cursor advances and it stops being a
  candidate. Restarting `notify` cannot resurrect a read item.
- **Non-nagging within a run** comes from an in-memory `seen` set of envelope ids — a notified (or
  watch-suppressed) item is recorded so the next poll doesn't re-fire it (the ADR 014 "never repeat"
  ethos). The resident process is *only* the delivery arm; losing the set on restart costs at most one
  repeat notification per still-unread item, never a missed one.

### 3. "Not watching / unreachable" — derived from presence, not a new state

`notify` suppresses the OS notification when the human is **actively reachable in-stream** — defined,
without inventing a v0.3 `availability` value, as **the human's roster `presence !== 'offline'`**: a
live `inbox --watch` pane (or app surface) sends a WS `hello` and shows online — the exact signal
ADR 024 already relies on. When the human is watching, the **bell + banner already reached them**
(ADR 024 piece A), so a second OS notification would be redundant; `notify` owns only the
*not-watching* case. On a clean detach the seat lingers for the 45s reclaim grace (held → online), so
suppression has a short tail after a pane closes — the natural grace window, accepted and honest. A
watch-suppressed item is marked `seen`, so it is treated as already-reached and won't fire later.

## Consequences

- **No SPEC / protocol-version bump.** Client-side, rides existing HTTP + the cursor; the wire is
  untouched (ADR 024 precedent). A.6a / `membership-model.md` remain the **governed superset**: this
  is their localhost Loud-only down-payment, and the tier/`away`/`urgent` names are the extension seam.
- **No daemon→desktop coupling.** The notifier is opt-in and human-side; the remote topology is safe.
- **Self-clearing & non-nagging.** Reading the inbox advances the cursor and silences `notify`; a
  watched act never double-notifies; an ignored notification doesn't repeat.
- **Opt-in.** `notify` is a process the human chooses to run; absent it, ADR 024's banner/bell/summary
  are unchanged. `--once` does a single poll-and-exit (cron-friendly and unit-testable); the default
  is the resident poll loop (`--interval <seconds>`, default 10).
- **Platform reach.** macOS + Linux now; other platforms no-op (the comeback summary still serves
  them). Windows toast is a later additive branch.
