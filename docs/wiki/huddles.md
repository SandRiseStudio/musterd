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

## What the room is, and is not

`open` lays the board out over the whiteboard service's localhost HTTP port when the service is already up: an **Anchor** cluster holding the anchor ref, a **Turns** cluster the opening line lands in; `say` mirrors each turn there. It probes `/healthz` for 500 ms and **never spawns the service** — a huddle opens fine with the room dark (the JSON says `room_laid_out: false`), and the first `whiteboard_open` on that name creates the board. Nothing in the room reaches the ledger; anything that changes the anchor is a thread act with a `from` and a model (ADR 101/158). Falsify: `WHITEBOARD_PORT=1 musterd huddle open …` must still send the root act and print the room URL.

## What is deliberately not here

- **No budget enforcement.** `budget` is a declaration; readers count the thread's rows against it. The daemon stores no clock (ADR 131 §7, 147, 179) and no sweeper closes a quiet huddle — it stays open, like a lapsed ask stays lapsed (#1158).
- **No cross-host wake.** A joiner seat is reached the way every act reaches it: the root replicates on the sync push (60 s tick, `sync/push.ts`) and its own machine's hook loop wakes it. Wake leases never travel (ADR 241, 356).
- **No `team_huddle_*` tools.** `team_send` with `meta.huddle` / `thread` / `meta.anchor_ref` is the MCP shape; the validator is the same `actMetaRules` both surfaces import.

## Where the rules live

| Rule | Where |
| --- | --- |
| `meta.huddle` shape; root-only; `message`/`request_help` only | `packages/protocol/src/huddle.ts`, `envelope.ts` (`actMetaRules`), `huddle.test.ts` |
| `meta.anchor_ref` on `resolve` only, non-empty | same |
| the CLI and its room payload | `packages/cli/src/commands/huddle.ts`, `huddle.test.ts` |
| the whiteboard accepts that payload | `packages/whiteboard/src/service.test.ts` ("accepts a huddle layout") |

Increment 2 (the office gathering on `/live` and the pop-out canvas) projects from the thread and presence on the firehose.
Follows-up: deferred — opened against ADR 378 when increment 1 has had one real huddle (2026-09-03)
