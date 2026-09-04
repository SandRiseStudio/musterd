# Huddles — a bounded burst of collaboration is a thread with a room

A huddle (ADR 378, accepted shape 2026-09-03) is several seats and a human converging on one topic in a bounded burst and leaving one artifact. On the wire it is nothing new: a root act carrying `meta.huddle`, turns as ordinary acts in its thread, and a `resolve` naming where the artifact landed. The daemon learns nothing; the live surface is a whiteboard room (ADR 330).

## How to run one (2026-09-03, increment 1 — `musterd huddle`)

```
musterd huddle open --topic lane:01M1N7Q2K5 --anchor docs/design/asks-rail.md --to miley,sloane --turns 12 "the asks rail arc — ring or bar?"
musterd huddle say <id> --act challenge "why a ring at all when the strip already has the tier?"
musterd send --act ask --thread <id> --to nick --meta species=consult --meta tier=standard "ring or bar?"
musterd huddle close <id> --anchor-ref docs/design/asks-rail.md@9ab435f0 "ring, drawn from the stored hue"
```

- **`open`** sends a `message` (or `request_help`) with `meta.huddle = { topic: {kind, id}, room, anchor, budget? }`. The envelope's own id is the huddle id. `--to a,b` is the ADR 254 eligible set; the default is `@team`. The room URL is derived: `http://127.0.0.1:<WHITEBOARD_PORT|4851>/b/huddle-<id lowercased>`; `--room` overrides it.
- **`say`** is a turn: `message`, `challenge`, `steer`, `insight` or `wait` with `thread` = the huddle id. `accept`/`decline`/`ask` are refused as turns on purpose: an answer names what it answers (`musterd send --reply-to`), and a question to a human is an `ask` with a tier (ADR 147) so it lands on the asks rail with an outcome record.
- **`close`** is the `resolve` (ADR 025) with `meta.anchor_ref` — a path@sha, a PR, a lane, or `none` with the reason in the body.

## Reading a huddle: the room is a view, not a venue

```
musterd huddle list            # the open huddles you are in (--all for everyone's, closed included)
musterd huddle show <id>       # the transcript: who is in it, who has yet to speak, turns vs budget
```

`show` renders the room — topic, state, turns taken against the budget declared, the anchor, the room URL, who has spoken and who was named but has not — then the turns in order, then how to answer. A closed huddle says where the artifact landed instead.

In the inbox a turn now reads `in huddle <topic>` rather than as a loose message to the team: a turn carries no huddle meta of its own, so without the root a reader could not tell which conversation it belonged to.

### And on the MCP surface (2026-09-04, increment 3)

The participants are agents, so the surface that had none of this was the one that mattered. `team_inbox_check` now answers the same three questions the CLI's room does, in the call that delivers the turn:

- the turn's own line says `↳ in huddle <topic>` (and `huddle_topic` in `structuredContent`);
- a room block follows the messages — what the huddle is for, who is in it, who was named and has not spoken, the anchor, and the last 6 turns including ones this seat has already read;
- the last line of an open room is the exact call that answers in it: `team_send {thread: "<id>", …}`.

The timeline read that supplies the root is paid for **only when the slice actually holds a threaded act**, and a failed read degrades to the bare messages the surface always showed. Falsify: an agent that has never seen the CLI can, from the tool surface alone, name a turn's topic and answer in it — `packages/mcp/src/tools/huddleRooms.test.ts`, whose five behavioural cases were verified red with the fold disabled (three controls stay green either way).

The fold itself moved to `packages/protocol/src/huddleView.ts` when this landed. It shipped CLI-local as "a rendering concern", which was half right: what a surface *draws* is its own, but *what a huddle is* — which rows belong to it, who is in it, whether it is closed — is a reading of the wire, and two copies of that fold would make the same room two different rooms.

### Why the log stays the transport (2026-09-04)

The alternative considered was a dedicated room a participant enters and cannot leave until the huddle ends — a meeting. It was rejected on two grounds, and the reasoning is worth keeping because the metaphor is attractive.

**It is not enforceable.** musterd runs no agent loops: the daemon runs no clocks on anyone's behalf and never injects into a session, so an agent's turn belongs to its harness. A "room" could only be a convention a seat honours, and on Claude Code or cursor nothing could hold it there.

**It is a lock with no release.** A seat that enters a huddle whose other participants never arrive is wedged — the failure measured in [claim-approval-latency](claim-approval-latency.md), where only 5 of 33 blocked claims were answered inside their window. It would also switch off the interrupt line exactly where a seat is most committed, so an urgent steer could not reach someone in a meeting.

So the log stays the transport — one cursor, recipient-scoped, replicated, already audited — and the room is a lens over it. A second delivery channel for huddle traffic would be a parallel message system needing its own replication, ordering and read state, which is the seventh-replicated-kind mistake in another costume.

## What the room is, and is not

`open` lays the board out over the whiteboard service's localhost HTTP port when the service is already up: an **Anchor** cluster holding the anchor ref, a **Turns** cluster the opening line lands in; `say` mirrors each turn there. It probes `/healthz` for 500 ms and **never spawns the service** — a huddle opens fine with the room dark (the JSON says `room_laid_out: false`), and the first `whiteboard_open` on that name creates the board. Nothing in the room reaches the ledger; anything that changes the anchor is a thread act with a `from` and a model (ADR 101/158). Falsify: `WHITEBOARD_PORT=1 musterd huddle open …` must still send the root act and print the room URL.

## What is deliberately not here

- **No budget enforcement.** `budget` is a declaration; readers count the thread's rows against it. The daemon stores no clock (ADR 131 §7, 147, 179) and no sweeper closes a quiet huddle — it stays open, like a lapsed ask stays lapsed (#1158).
- **No lock.** A participant is never held in a huddle; the mode is declared and honoured, not enforced. See the rejection above.
- **No cross-host wake.** A joiner seat is reached the way every act reaches it: the root replicates on the sync push (60 s tick, `sync/push.ts`) and its own machine's hook loop wakes it. Wake leases never travel (ADR 241, 356).
- **No `team_huddle_*` tools.** `team_send` with `meta.huddle` / `thread` / `meta.anchor_ref` is the MCP shape; the validator is the same `actMetaRules` both surfaces import. Re-argued and re-affirmed when the read surface landed (2026-09-04): a tool earns its place by being *selectable*, and reading a huddle is never a selection — a huddle reaches an agent exactly one way, as a turn in its inbox, so the read belongs at the arrival. The cost points the same way: a tool costs its name, description and schema in every seat's tool list on every turn forever, against 383 B of muted headroom measured that day; the field cost **0 B standing** (`pnpm context:check` identical before and after).
- **No way to browse a room you have no unread in** (2026-09-04). `musterd huddle list` does that for a human and has no MCP counterpart, deliberately. Falsifier: if a seat is seen wanting the room it is *not* being spoken to in, that is the evidence for a tool.

## Where the rules live

| Rule | Where |
| --- | --- |
| `meta.huddle` shape; root-only; `message`/`request_help` only | `packages/protocol/src/huddle.ts`, `envelope.ts` (`actMetaRules`), `huddle.test.ts` |
| `meta.anchor_ref` on `resolve` only, non-empty | same |
| the fold both surfaces read a room with | `packages/protocol/src/huddleView.ts` |
| the CLI and its room payload | `packages/cli/src/commands/huddle.ts`, `huddle.test.ts` |
| the room an arriving turn came from, on MCP | `packages/mcp/src/tools/huddleRooms.ts`, `huddleRooms.test.ts` |
| the whiteboard accepts that payload | `packages/whiteboard/src/service.test.ts` ("accepts a huddle layout") |

Increment 2 (the office gathering on `/live` and the pop-out canvas) projects from the thread and presence on the firehose.
Follows-up: deferred — opened against ADR 378 when increment 1 has had one real huddle (2026-09-03)
