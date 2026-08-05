# Seat footprint — measuring, dieting, and reaping the per-agent cost of a machine

**Date:** 2026-08-05
**Status:** Design approved in conversation (nick + kimi); implementation not started
**Scope:** Phase 0 ops diet for nick's laptop + the first musterd product increment (footprint observability + reaping). Admission control and cloud seats are explicitly future work.

## Problem

On an 8 GB laptop, 3 concurrent musterd agents run smoothly, 4 slow the machine
noticeably, and 5 bring it near a standstill. Measured on 2026-08-05 with 3–5
nominal agents:

- swap at **10.1 GB used of 11 GB** (8 GB physical RAM)
- **256 agent-stack processes**; **~13 full MCP sidecar stacks** alive — one per
  session that *ever* started, including dead ones
- each stack ≈ 12–14 processes (supabase ×2, playwright, chrome-devtools,
  flyctl, elevenlabs-python, pdf-server, mcp-remote, cognee-python, …), because
  every session inherits the user's *global* MCP server list regardless of role

So the marginal cost of "one more agent" is not one process — it is a full
sidecar stack, and dead sessions never return their stacks. Three distinct
problems compound:

1. **Orphan accumulation** — sidecars outlive their sessions (a known dogfood
   trap: "reload orphans MCP procs").
2. **Per-seat footprint ~10× necessary** — globally-configured MCP servers
   spawn for every seat that will never call them.
3. **Genuine concurrency ceiling** — an 8 GB machine has a real limit even
   after the diet; nobody currently measures where it is.

### Is 5 agents even smart?

The cookoff (finding 006) showed *coordination* pays at N=3 (1.9 % wasted work
vs 72 % uncoordinated) — it did not show the marginal agent pays beyond that on
one project. The design therefore separates **seats** (durable identities,
cheap) from **resident sessions** (what eats RAM). A team can hold 8 seats with
3 resident; ADR 131 residency already gives parked seats a wake path. The goal
is not "5 heavyweight sessions forever"; it is "the machine's honest ceiling,
measured, visible, and never silently exceeded".

## Phase 0 — ops diet (no product code)

Measurement bookends every step: snapshot → change → snapshot, so each lever's
effect is attributable.

- **Step 0 — baseline probe.** `scripts/perf/seat-footprint.mjs` (in-repo
  deliberately; it seeds the product sampler). Each run appends to
  `docs/perf/seat-footprint.md`: swap used, memory pressure, sidecar stacks
  grouped by parent session (live vs orphaned), RSS per stack, total
  agent-stack process count.
- **Step 1 — reap orphans (manual pass).** Heuristic: a stdio MCP sidecar
  reparented to launchd (ppid 1) whose session is gone is orphaned; live
  sessions' sidecars have a living harness ancestor. Expect ~8–10 of the 13
  stacks (~100+ procs) to go.
- **Step 2 — scope the MCP config.** Global Claude config keeps **musterd
  only**; every other server (ElevenLabs, Figma, Supabase ×2, Playwright,
  chrome-devtools, flyctl, pdf, cloudflare) moves to per-project `.mcp.json`
  where actually used, or is dropped until needed. Per-session sidecars drop
  from ~13 procs to ~2. Snapshot `~/.claude.json` first (cell provisioning has
  clobbered `mcpServers` before).
- **Step 3 — placement policy.** Desktop app only for the 1–2 seats nick
  actively converses with; heads-down worker seats run as terminal `claude` in
  their worktrees (no Electron renderer per seat). Launches staggered — the
  cookoff measured that simultaneous launch crashes the machine.
- **Step 4 — restart + re-measure.** Swap does not drain on its own; one
  restart clears it. Then the test that matters: stagger-launch 5 seats, all
  actively working, probe every few minutes.

**Success criterion:** 5 active seats with swap stable (not climbing) and the
UI responsive. If 5 does not hold after the diet, that number is the honest
8 GB ceiling — and it feeds admission-control thresholds later.

## Approach A — seat footprint observability + reaping (the product)

**Principle:** the daemon already knows every seat, session, and lane on the
machine; it should also know what each one costs. Nothing blocks; everything is
visible; reaping is explicit. Warn-never-block, same as lanes.

### A1. Sampler (daemon-side)

A periodic tick (~60 s, alongside the ADR 232 presence heartbeat) runs one
cheap `ps` scan and builds the process picture:

- Processes matching a **known-sidecar allowlist** (command patterns:
  `npm exec *mcp*`, `flyctl mcp server`, `*-mcp`, `mcp-remote`, musterd's own
  `packages/mcp/dist/index.js`, …) are grouped into *stacks* by walking parent
  chains.
- A stack is attributed to a session where possible — the musterd MCP process
  in a stack carries the binding's session identity.
- Classification: **live** (ancestor chain reaches a living harness process),
  **orphaned** (reparented to ppid 1, no live session claims it), or
  **unattributed** (ambiguous — shown as such, never guessed onto a seat).
- One **machine row** per tick: swap used, free memory, memory pressure.
- Darwin first (where the dogfood pain is); `ps` parsing sits behind a small
  platform module so Linux lands later without surgery.

### A2. Storage

A `footprint` table in the daemon's sqlite: per-tick stack rows (seat, session,
proc count, RSS, classification) plus the machine row. Retention capped
(~7 days) so the table cannot become its own resource problem.

### A3. Surfaces

- **`musterd status`** — a calm per-seat cost chip
  (`miley · working · 14 procs / 1.1 GB`) and one machine line at the top; it
  becomes a warning only above thresholds derived from Phase 0 measurements,
  not guesses.
- **`musterd init --check` / doctor** — orphan report: "3 orphaned MCP stacks
  (41 procs, ~600 MB) from sessions that ended".
- **`musterd reap`** — lists orphaned stacks and what it would kill; applies
  with `--yes`. SIGTERM with a grace period, then escalate. Every kill
  re-verifies the PID's command line at kill time (no TOCTOU kills), touches
  only allowlist matches, and writes a `footprint.reaped` audit event to the
  ledger.
- **/live** — a small machine-health chip, reserved in the data model now;
  the frontend itself is miley's (standing rule: all web UI is miley's).

### A4. Error handling

- The sampler can never hurt the daemon: `ps` failure → skip the tick, note it.
- Ambiguous attribution → `unattributed`, never guessed.
- Reap refuses anything outside the allowlist even when asked.

### A5. Increments

1. Sampler + doctor orphan report (read-only)
2. `musterd reap`
3. `musterd status` / roster surfacing (+ /live data reserved for miley)

Each lands as its own PR. ADR number picked late against origin/main
(collision trap).

## Observability & Evaluation

- **Metrics:** orphan-stack count over time; per-seat process-count and RSS
  distributions; machine swap/pressure curves; `footprint.reaped` events in
  the ledger.
- **Evaluation loop:** `scripts/perf/seat-footprint.mjs` is the standing eval
  harness. The 5-seat stagger test re-runs after Phase 0 and after each
  Approach A increment; results log to `docs/perf/seat-footprint.md`. Approach
  B thresholds (future) come from these curves, not guesses.

## Testing

- Unit: classify fixture `ps` outputs (live / orphaned / unattributed);
  stack-grouping from synthetic process trees.
- Integration: one through-DB test per new act/table (ADR 103 rule).
- Reap: injected kill function — tests never kill real processes.

## Future work (explicitly out of scope here)

- **Approach B — admission control:** presence carries a machine-load signal;
  launching a seat past capacity gets a visible warning / soft hold via the
  existing ask machinery. Ships only after A's measurements set honest
  thresholds.
- **Lean provisioning by default:** `musterd agent` / init provisions worker
  seats with a minimal, role-scoped MCP set (ADR 027/144 machinery) so the
  Phase 0 diet becomes the product default.
- **Cloud seats:** overflow seats off-laptop (Claude Code cloud sessions,
  Cursor background agents, or a Fly runner joining the daemon over Tailscale
  via the ADR 039/040 off-loopback bind). Users on constrained machines will
  want this; it is the scale story past one machine's ceiling.
