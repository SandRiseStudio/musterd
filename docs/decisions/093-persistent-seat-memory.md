# 093 — Persistent seat memory: a continuity blob, headline-first

- Status: accepted (built + merged 2026-07-06 — PRs #129/#130: protocol envelope, server store/routes, MCP tools + join one-liner, CLI `memory` + claim/status pointer, skill playbook)
- Date: 2026-07-06

## Context

The memory seam has been reserved since the membership model froze: "a persistent identity wants
persistent memory, but musterd is a coordination layer, not a memory store — we reserve the seam
(the claim response can later carry a memory/context blob alongside the charter) and integrate/build
memory later" (`membership-model.md` §Scope boundaries). The reservation is concrete in code:
`OccupiedFrame.memory` exists today and is **forced to `null`** (SPEC A.3,
`packages/protocol/src/claim-handshake.ts`). The roadmap prioritized this as the next design pass
after telemetry L2 (Wave 5 — Depth), and it needed a design session before build; this ADR is that
session's record.

The agent=seat ontology (`agent-ontology.md`) makes the want sharp: the seat is the persistent
identity, but today a seat that re-occupies remembers nothing. When a session ends — reload, crash,
a handoff-to-self tomorrow — the seat's working state evaporates with the harness transcript, and
every fresh session burns its first turns re-orienting.

## Problem

Give a seat memory that survives the session gap, without violating what musterd already is:

- **Not a second home for facts.** Domain knowledge belongs in docs; the charter already carries
  "what this seat is for"; prior work is _derivable_ from threads/lanes/acts (the ADR 050/090
  derive-don't-store principle). Memory must not become a drifting duplicate of any of these.
- **Not a context tax.** Whatever is delivered at claim time lands in every fresh session's context
  window; an 8KB dump on every occupy would cost ~2K tokens whether or not it is relevant.
- **Not a leak.** Working notes can contain anything; team-wide readability or git persistence
  would widen exposure without serving the continuity job.

Open questions the roadmap named: what the blob holds, who writes it and when, size/staleness
bounds, and how it composes with agent=seat.

## Decision

**The v1 job is cross-session continuity only** — the working state a returning occupant needs
(what it was doing, decisions mid-flight, where it left off; operating preferences may ride in the
prose). Durable seat knowledge stays in docs; the prior-work index stays derived (report engine);
neither goes in the blob.

### 1. The occupant writes it, explicitly

A `memory_save` verb — the MCP tool `team_memory_save { headline, body }` and CLI
`musterd memory save --headline "<subject>" [body]` — called by the occupant at natural boundaries
(before a handoff, at a wrap-up `status_update`, when told to wind down). Self-reported like
`working` (the two-clocks rule): musterd stores, never composes. No harness-hook auto-save and no
server-derived digest in v1 — the derivable part already has surfaces (`report`, `inbox`), and
composition can be layered later without a schema change.

### 2. One small blob, headline-first (the context-budget design)

- **Single blob per seat, last-write-wins.** No history, no versions.
- **Headline required** (≤120 chars) + **body ≤8KB**, rejected above the caps with the limit named.
  The headline/body split is the commit-subject convention agents already know — and it is what
  keeps the per-session cost low.
- **`saved_at` stamped; no server expiry.** Stale working state is the _reader's_ call: the age is
  shown, the server never silently drops.

### 3. Delivery: envelope on occupy, body on demand

`OccupiedFrame.memory` goes from always-`null` to `MemoryEnvelope | null` where
`MemoryEnvelope = { headline, saved_at, size_bytes }` — the seam un-stubbed, carrying the envelope,
**never the body**. The `team_join` result / `musterd claim` output render at most one line:

> Saved memory from 2h ago: "mid-refactor of ws.ts eviction, tests red" — `team_memory_read` to load it.

Cost per session ≈ 30 tokens; the agent makes an informed fetch decision. The body travels only
over an explicit read (`team_memory_read` / `musterd memory`). A mechanically truncated preview was
rejected (it makes a bad first line and invites no discipline); full-blob-on-occupy was rejected as
the context tax above.

### 4. Storage and visibility: daemon-private, seat-scoped

- **Daemon-private DB** (`seat_memory` table: `member_id` PK/FK, `headline`, `body`, `saved_at`).
  Never the git seat-file: memory is live working state — presence's side of the ADR 058
  durable/live line — and committing half-done context (or secrets pasted into notes) into repo
  history is exactly the failure a git sidecar invites.
- **Readable by the seat itself and the platform operator only.** The HTTP surface authenticates as
  the seat (occupant token must match the target seat); there is **no cross-seat read path — team
  admins included**. This deliberately narrows the v0.3 rule that `visibility_level: admin` sees
  everything (ADR 071): memory is a note-to-self, not team state. The platform operator (who runs
  the daemon) inspects via the DB file or telemetry they already control; no API pretends otherwise.
- **Memory belongs to the seat, not the occupant.** A new occupant adopting the seat inherits the
  note — the agent=seat ontology, and exactly right for handoff continuity.

### 5. Surfaces (minimal)

- **HTTP:** `PUT /teams/:slug/memory` (save), `GET …/memory` (read-back), `DELETE …/memory`
  (clear) — all seat-authenticated.
- **MCP:** `team_memory_save`, `team_memory_read`; the `team_join` one-liner.
- **CLI:** `musterd memory save|show|clear`; `musterd claim`/`status` print the same one-liner.
- **Guidance:** the _skill_ (not the primer kernel) gains the "save your memory before handing
  off / wrapping up" playbook line — the primer stays the lean loop kernel (ADR 085).
- **Audit:** `memory.save` / `memory.clear` record **sizes only, never content** (the no-secrets
  hard rule).

### 6. SPEC impact

SPEC A.3's `memory: null` reservation becomes the optional envelope — a SPEC minor gated by this
ADR (hard rule 1). Additive: older clients that ignore `memory` lose nothing.

## Consequences

- A returning agent starts warm for ~30 tokens, and pays the body's cost only when it chooses to.
- The headline requirement is a writing discipline; a lazy save with a vague headline degrades only
  its own future usefulness, not every session's context window.
- No auto-save means a crashed session saves nothing — accepted for v1; the harness-hook auto-save
  (SessionEnd/PreCompact) is the named follow-up seam if dogfood shows agents forget to save.
- Team admins losing read access to one category of seat state is a deliberate precedent: private
  working notes exist inside a governed team. Cross-seat inspection needs (debugging a stuck seat)
  route through the platform operator.
- `seat_memory` is a new table (migration) but no new runtime dependency.

## Observability & Evaluation

- **Traces:** `memory.save` / `memory.read` / `memory.clear` ride the existing
  `musterd.cli.command` / `musterd.tool.call` spans (ADR 089); the save span records
  `memory.size_bytes` and `memory.headline_len` as attributes (never content).
- **Eval:** the headline's usefulness signal is the **read-after-occupy rate** — of occupies whose
  join result carried a memory line, what fraction fetched the body within the session. Metric:
  time-to-first-productive-act for sessions that read memory vs sessions that had none (baseline:
  current cold-start sessions in the L2 data).
- **Experiment:** none yet — named: A/B the join one-liner on/off across dogfood sessions and
  compare re-orientation turns.
