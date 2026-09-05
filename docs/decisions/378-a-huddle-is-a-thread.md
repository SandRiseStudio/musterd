# 378 — A huddle is a thread: `meta.huddle` on the opening act, turns as messages, `resolve` names the anchor; the room lives outside the daemon

- Status: proposed
- Date: 2026-09-03
- Builds on: [ADR 025](025-resolve-act-thread-close.md) (a thread is closed by `resolve`), [ADR 103](103-steer-challenge-defer-acts.md) (additive meta, no wire-version bump), [ADR 128](128-recipient-scoped-message-reads.md) (recipient-scoped reads; the injection bar), [ADR 131](131-harness-residency-wake-ledger-host.md) §7 and [ADR 179](179-board-triggered-work-order-wakes.md) (the daemon runs no clocks; a wake carries a lane id only), [ADR 145](145-human-role-refounded.md) §4 ("surfaces before more acts"), [ADR 147](147-human-ask-stream.md) (a to-human question is an `ask` with a tier), [ADR 241](241-a-wake-verifies-against-its-own-lease.md) and [ADR 356](356-presence-replication.md) (wake leases are local-only and never travel), [ADR 325](325-multi-machine-federation.md) and [ADR 365](365-the-ledger-kind.md) (the three residences; six replicated kinds and what each costs), [ADR 330](330-agent-whiteboard.md) (a named, ephemeral, WS-synced room already exists, and it lives outside the daemon on purpose), [ADR 259](259-memory-git-truth-derived-indexes.md) (where durable output lands)
- Lane: 01M1N97TQK1J1VJK6F2QM17JEK (this ADR); the implementation increments are schmidt's to open against it

## Context

schmidt's brainstorm (2026-09-03, nick's ask) proposes real-time agent collaboration: several
seats and a human converge on one topic — a goal, a lane, a design question — in a bounded burst,
and leave behind one artifact. The framing it arrived with:

- ephemeral **huddle rooms**, daemon-mediated WebSocket at `/ws/huddle/:id`, topic-bound;
- **guardrails against the token storm**: `@seat` addressing for immediate turns, debounce and
  jitter on `@all`, a hard turn budget (fifteen was the number) and a TTL;
- an **anchor artifact** — a living scratchpad (draft spec, ADR, patch) that the turns update and
  that persists on close;
- **doorbell wakes** through the five harness hook rails measured this week, so nobody polls;
- **multi-machine** reach on top of the federation arc.

Increment 2 projects visual surfaces from it: avatars walking from their desks to a huddle spot on
`/live` and `/broadcast` with speech bubbles, a pop-out canvas on `packages/whiteboard`, and a
hybrid that links the two.

The intent is right and the surfaces are wanted. The substrate as framed sits on the wrong side of
several written invariants, and each collision has a cheaper shape already in the codebase. This
ADR fixes the contract the increments build against so the visual layers project from something
that will not have to move.

### What the daemon is not allowed to be

1. **`transport/ws.ts` serves exactly one upgrade path, `/ws`**, claim-scoped and gated by the
   Host/Origin boundary (`checkUpgrade`). `transport/hub.ts` is "purely the live-push layer";
   durability is the database. A room registry with lifecycle would be the first stateful thing
   in the push layer, on a second authentication surface.
2. **The daemon runs no clocks on anyone's behalf** (ADR 131 §7, ADR 147, ADR 179). A debounce
   window, a jitter, a TTL and a turn counter are clocks and stored posture. Every rate-shaped
   decision in `store/residency.ts` is **derived from audit rows, never stored** — a `turns_left`
   column on a room object is exactly the field those decisions refuse.
3. **No agent-authored text enters a spawn prompt** (ADR 179; ADR 128's injection bar). A wake
   carries a lane id. A room that wakes a seat *with the room's content* is the daemon doing
   intra-task orchestration, which is the pattern musterd exists as the alternative to.
4. **A room already exists, and it is outside the daemon by decision.** ADR 330's whiteboard
   service runs `WS /ws/:name` with a room manager, per-actor attribution, versioned `since`
   reads and persistence, imports nothing from `@musterd/*`, and never writes into a repository.
   That is a huddle's shape minus the transcript.

### What the wire already has

`ACTS` is closed and append-only (thirteen verbs); ADR 145 §4's rule is surfaces before more
acts, and the last three additions each shipped as `meta` on an existing verb. The only grouping
primitive is `thread` — the root envelope's id — and `resolve` is the act that closes one (ADR
025). Reads are recipient-scoped (ADR 128): a room that fanned directed traffic to non-parties
would breach that regardless of where it was hosted.

### What federation already decided

State has three residences (ADR 325): hub-authoritative, replicated append-only, local-only.
Messages replicate (kind 1). **Wake leases are residence 3** — local-only, "off-host a string with
no verifier" (ADR 356), and a wake credits only evidence naming its own lease id (ADR 241). The
ledger now carries six kinds (messages, lane, presence, ledger, continuity, record), each paid for
with an allocator rule, a fold, a residence check and an origin rule. `sync/push.ts` offers a
node's events to the hub on a sixty-second tick, cursor advanced on ack. Nothing in the
federation arc crosses a host in under that tick, and nothing wakes a seat on another host.

## Problem

Represent a bounded, topic-bound, multi-party burst of collaboration — with a live surface and
one durable artifact — without a new act, a new upgrade path in the daemon, a stored clock, a
seventh replicated kind, or a cross-host wake that no lease can verify.

## Decision

**A huddle is a thread.** Its transcript is the thread's acts; its live surface is a room in the
whiteboard service; its output is a file a seat lands under its own identity. The daemon learns
nothing new.

### 1. The opening act carries `meta.huddle`; the thread id is the huddle id

Any seat opens a huddle by sending a `message` (or a `request_help`, when the huddle exists to
unblock a lane) with:

```ts
meta.huddle = {
  topic: { kind: 'goal' | 'lane' | 'design'; id: string },  // what the huddle is bound to
  room: string,            // the room's URL in the whiteboard service, e.g. http://127.0.0.1:4851/b/huddle-01M1…
  anchor: string,          // where the durable output will land: a repo path or a PR/lane ref
  budget?: { turns?: number; until?: number },  // DISPLAYED by readers; enforced by nobody in the daemon (§4)
}
```

The envelope's own `id` is the huddle id, and the room is named after it. `to` is the participant
set: named seats, or `@team` for an open huddle. Every participant reads it through the ordinary
inbox, the ordinary firehose subscription shows it to observers with visibility (ADR 128), and it
replicates as a message, which is all the cross-machine reach a huddle gets (§3).

`meta.huddle` is validated in `actMetaRules` exactly as `meta.urgent` and `meta.confidence` are:
optional, additive, refused when malformed (a `topic` with no `id`, a `room` that is not a URL,
an `anchor` that is empty). No wire-version bump (ADR 103).

### 2. Every turn is a `message` in the thread; the room carries what the thread does not

A turn is an envelope with `thread` set to the huddle id. The existing acts are the huddle's
vocabulary and need no synonym: a directed `message` is an `@seat` turn; `challenge` is
"justify that"; `steer` redirects; `wait` is "deciding, back at T"; `insight` promotes a finding.
`meta.huddle` appears once, on the root — a turn that repeats it is malformed.

The room holds the traffic that is not a turn: partial speech as it streams, cursors, reactions,
the anchor's live draft, presence in the room. None of it enters the ledger. The line is drawn by
consequence: **anything that changes the anchor is a thread act**, with `from` and model
attestation (ADR 101/158); a bubble that never reaches the thread is ambience and decides nothing.

### 3. Membership is the thread's; reach is the ledger's

Who is in a huddle is derivable — the root's `to`, plus anyone who has posted in the thread — and
the room keeps no roster of its own. Whether a participant is *here* is presence (ADR 356,
replicated). The room's own presence is the room's, for its own display.

A huddle reaches a seat on another machine the way every act does: the thread act replicates on
the next push tick, the receiving daemon's own hook loop sees a directed act for a resident seat
and wakes it with a lane id, verified against a lease that machine minted (ADR 241). **No room
opens a socket to a seat, and no huddle mints a wake.** The consequence is stated rather than
hidden: cross-host liveness is bounded below by the sync tick, today sixty seconds. _(Amended
2026-09-04: measured false for the live bell — the sync tick is a floor on the DATA, not on the
notification, and a cross-host turn can be buried permanently rather than merely delayed. The
convene wake survives; see "The bell does not ring across machines" in Consequences.)_ On one host
the directed-act rail is the same one `request_help` already rides and needs no new doorbell
integration.

### 4. Budgets are displayed, derived, and owned by the participants

`meta.huddle.budget` is a declaration. `/live`, `/broadcast` and the CLI render turns-used and
time-left by counting the thread's rows and reading the root's `ts` — the reader derives, the
daemon stores nothing and refuses nothing. Enforcement belongs where ADR 147 put the clock: with
the agents. A seat that sees the budget spent posts `resolve` or stops; a harness hook that wants
to be strict can refuse its own seat's next turn. The room may grey out the composer; it must not
drop frames.

A huddle that goes quiet with no `resolve` is *open*, listed as such by the surfaces, exactly as
a lapsed ask is not a waiting one (#1158). No TTL sweeper: the daemon runs no clocks.

### 5. A question to a human inside a huddle is an `ask`

`@all` addressed to a human is not a room ping. It is an `ask` in the thread with `meta.species`
and `meta.tier` (ADR 147), so it lands on the asks rail with a contract and an outcome record. The
alternative — a bubble a human might or might not have seen — is the evasion #1158 just closed.

### 6. `resolve` closes the huddle and names where the anchor landed

The closing `resolve` (ADR 025) carries `meta.anchor_ref`: the repo path and commit, the PR, or
the lane that now owns the work. The room's final state is the whiteboard's business (ADR 330 §6
returns the outline on close); the durable output is a file a seat writes on a branch in a lane
under its own name (ADR 259). A huddle whose anchor never lands is closed with
`meta.anchor_ref: 'none'` and the reason in the body, which is honest and searchable.

### 7. The room is a whiteboard room with a huddle layout

`packages/whiteboard` gains one board layout — anchor document plus a turn strip that mirrors the
thread — and nothing else structural. `@musterd/server` gains no upgrade path, no room registry,
no schema. The whiteboard's non-import invariant (ADR 330 §1) holds: the room does not read the
ledger; the thin surface that writes thread acts and points at the room is musterd's (a
`musterd huddle open|say|close` CLI and the matching `team_*` shape, both writing ordinary
envelopes).

## Observability & Evaluation

- **Traces:** none new. A huddle is the root envelope's `meta.huddle` plus every envelope whose `thread` names it, and the closing `resolve` with `meta.anchor_ref` — all ordinary `messages` rows, replicated as kind 1. `SELECT ... WHERE thread = :id` is the whole transcript; a reader that counts those rows against `meta.huddle.budget` has the budget display.
- **Eval (increment 1):** a two-daemon test — a joiner seat's turn appears on the hub's `/live` within one sync tick, and `@musterd/server` has no route matching `/huddle`, no table, no new replicated kind (the census test pins the six). Falsifier: any daemon-side state whose only reader is the huddle surface.
- **Eval (the budget line):** over the first twenty huddles, the share that end in `resolve` with a non-`none` `anchor_ref` versus the share left open past their declared `until`. Baseline is the asks record (#1158): 14 of 41 asks never reached a terminal state. A huddle should do better because the close is the artifact landing, not an honour-system envelope; if it does not, the budget belongs in the harness hook, still not in the daemon.
  Follows-up: deferred — the twentieth closed huddle, measured on the thread rows (2026-09-03)
- **Experiment:** n/a — a representation decision. The comparison that matters is the one above, against the daemon-hosted room shape that was never built.

## Alternatives considered

- **A daemon-hosted `/ws/huddle/:id` with turn budgets and TTL** (the framing as received).
  Three invariants at once — one upgrade path, no clocks, derived not stored — and a second
  stateful surface inside the push layer. Rejected above.
- **A `huddle` act, or `huddle_open` / `huddle_turn` verbs.** ADR 145 §4. A thread already
  groups; `resolve` already closes; the last three additions were meta on existing verbs. A verb
  would also need every reader that switches on `act` to learn it.
- **A seventh replicated kind for room membership and turn state.** Every kind costs an
  allocator rule, a fold, a residence check and an origin rule (ADR 365, 366, 371), and a
  huddle's state is fully derivable from the thread. ADR 365 §3 names "should caps be team-wide"
  as an open question; this ADR declines to answer it inside a feature.
- **Waking remote seats from the room.** No lease can verify it (ADR 241, 356). The only path
  is the one every act already has.
- **The anchor lives in the room.** Boards never write to a repository (ADR 330 §6) and a
  service process has no seat identity; the artifact would have no lane, no attestation, no
  review. The seat lands it.
- **Enforce the budget in the daemon.** A stored counter the daemon decrements is the field ADR
  131's readers exist to never need. The agent owns the clock (ADR 147).

## Consequences

- One additive meta shape on the wire, validated in `actMetaRules`; no version bump, no new act,
  no new table, no new replicated kind, no new daemon endpoint.
- **Increment 1 landed 2026-09-03** (PR #1274, lane 01M1NBEP26YVXS30SWHWPGJNFB): `meta.huddle` and
  `meta.anchor_ref` validated in `packages/protocol/src/huddle.ts` + `envelope.ts`;
  `musterd huddle open|say|close`; the whiteboard room laid out over its HTTP port only when the
  service already answers, never spawned. Runbook: `docs/wiki/huddles.md`.
- The visual layers (office gathering, canvas, hybrid) project from the thread and presence on the
  firehose, the same feed `/live` reads today, plus the whiteboard room they embed or link.
- Cross-host huddles are honest about their latency: bounded by the sync tick. A faster push on a
  directed act is a federation change, not a huddle change.
  Follows-up: deferred — the first cross-host huddle whose participants call the tick too slow (2026-09-03)
- **The bell does not ring across machines (2026-09-04, measured; amends §3's latency sentence).**
  stanley ran the two-daemon falsifier for real — the hub on this laptop and the `delta` seat on a
  Fly VM in sjc, build `16b6e3d8`, huddle `01M1Q1NR8B`. The DATA half held exactly as §3 says: the
  root and three turns folded onto delta at 48.4s / 53.0s / 83.2s / 91.8s against a sixty-second
  poll, with `meta.huddle` and `thread_id` verbatim and the root's `to_member` resolved to delta's
  own local id. The NOTIFICATION half did not: twenty `inbox --interrupt-check` probes across two
  runs, silence every time. So "bounded below by the sync tick" is a floor on when a turn ARRIVES,
  and §3 read it as a floor on when a seat is TOLD. Those are different claims and only the first
  was true.

  Two independent causes, and the ADR is only answerable for the second.

  The first was not a huddle defect or a cross-machine one. `GET /inbox/interrupt-check`
  authenticates as a member, and the probe alone is excluded from both lease heals by design, so a
  session lease that died with its Presence refused the route forever while a bare `catch {}`
  swallowed the 401 — every seat, every harness, permanently and silently deaf on the interrupt
  line while looking healthy in every other respect. Repaired in #1317 (lane 01M1QC6XST): the probe
  now says so, on the channel it already owns, and still never reclaims.

  The second is this ADR's, and no repair above touches it. A huddle turn is **the only
  interrupt class whose admission depends on a second row** — `interruptCandidates.ts` demands the
  huddle ROOT exist locally (`:50-57`) while bounding the window on `created_at > cursorTs`
  (`:43`) exactly as it does for self-describing acts. Cross-host the two rows arrive out of order:
  a turn can fold before its root, and the daemon stamps the folded row with its own receipt clock
  (`fold.ts` rule 4). If any unrelated inbox read falls in that gap, the cursor advances past the
  turn's `created_at`, and when the root finally lands the turn no longer clears the window. It is
  not late — it is invisible, forever. stanley demonstrated it by accident inside the falsifier
  run: reading delta's inbox advanced its cursor to 1788562249698, past turn 1 at 1788561769690,
  and that turn can never ring under any fix.

  **Bounded on purpose:** this costs the live bell and nothing else. The wake rail never listened
  for turns — `residency.ts` passes only `huddleOpens: lanes.conveneHuddles`, never `huddles: true`,
  because ADR 386 made the OPEN act a wake reason and turns deliberately not one. And the root is
  the one row the window cannot swallow, for the same reason it swallows the turn: it folds LAST,
  so its `created_at` is above the cursor, and it is admitted on its own `meta.huddle`. A
  cross-machine convene therefore fires on the tick after the root arrives. Claiming both rails die
  would be an overstatement, and was made and withdrawn inside the huddle.

  So the correct statement of the defect is narrower than "cross-host huddles are slow" and worse
  than it: a huddle turn is cursor-bounded as if it were self-describing, and it is not. The repair
  is not this ADR's to specify — it belongs with whoever owns `interruptCandidates` — but the
  sentence that said the failure was a delay is withdrawn.

  Evidence: `docs/wiki/cross-machine-huddle-bell.md` (stanley, PR #1315). Falsifier for the
  amendment itself: fold a turn onto a second daemon with its root held back, read that seat's
  inbox, then release the root, and check whether the bell ever rings. It does not.
- Falsifier for the whole shape: a two-daemon test where a joiner seat's turn appears on the hub's
  `/live` after one sync tick, with `@musterd/server` holding no room state and no new route.
- Increment 1 (schema + CLI/tool surface + whiteboard layout) and increment 2 (visual surfaces)
  are schmidt's lanes, opened against this ADR once accepted.
  Follows-up: deferred — schmidt opens the increment lanes on acceptance of this ADR (2026-09-03)
