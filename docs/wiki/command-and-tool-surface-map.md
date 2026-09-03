# Command and tool surface map — 47 CLI commands, 30 MCP tools, and the words that mean two things

One map of every `musterd` command and every `team_*`/`lane_*` MCP tool: the question each answers, its twin on the other surface, and the collisions where one word carries two meanings — surveyed 2026-09-03 (lane 01M1MKSMBP, nick's ask after the `nudge` confusion).

## Method (2026-09-03)

Inventory from `packages/cli/src/help/catalog.ts` (47 catalogued commands, 7 help groups), `packages/cli/src/bin.ts` (50 dispatch cases), `packages/mcp/src/toolNames.ts` (30 tools), the 13 protocol acts (`message status_update request_help handoff accept decline wait resolve steer challenge defer ask insight`), and the hook command strings `musterd init` provisions. Lens: BOTH surfaces — a human at the terminal and an agent on the MCP tools should each be able to tell which question a name answers, and a name should mean the same thing on both. Falsifier for the whole page: `pnpm musterd help` and `toolNames.ts` at HEAD; a row is wrong when the command or tool named no longer exists or its summary answers a different question.

## The map

Twin grade: **same** = same name, same meaning; **meaning** = same meaning, different name; **none** = no twin on the other surface.

### What is waiting for me / who am I

| CLI | MCP | twin | question |
| --- | --- | --- | --- |
| `inbox` | `team_inbox_check` | meaning | read what waits; both advance the cursor. CLI adds `--watch`, `--wait`, `--interrupt-check`, `defer` — five modes in one verb |
| `inbox --waiting` (~~`nudge`~~ until 2026-09-03; hidden alias one release) | — | none | the waiting-acts banner and acts, read-only, at the approval prompt (ADR 053) |
| `status` | `team_status` | same | the roster; CLI leads with the waiting banner |
| `next` | `team_next` | same | the orientation brief (ADR 049/084) |
| `whoami` | — | none (the primer tells the agent who it is) | which seat this folder resolves to |
| `availability` | — | **none — an agent cannot set away/dnd** | availability (ADR 044) |
| `wake-context` | `team_wake_context` | same | bounded wake packet (ADR 209) |
| `notify` | — | none | OS notification poller while away (ADR 035) |

### Talking

| CLI | MCP | twin | question |
| --- | --- | --- | --- |
| `send --act <act>` | `team_send {act}` | same | one typed act; the 13 act names are shared verbatim |
| — | `team_members` | **none — CLI `status` has no per-member detail or `--role` filter** | who holds a duty, one member's detail (ADR 227) |

### Work

| CLI | MCP | twin | question |
| --- | --- | --- | --- |
| `lane open/claim/release/handoff/update` | `lane_open/claim/release/handoff/update` | same | declare and own a unit of work |
| `lane submit` | `lane_submit` | same | after merge: attest and ask acceptance (ADR 192) |
| `lane ready` | `lane_ready` | same, **deprecated alias of submit** on both | — |
| `lane resolve` | `lane_resolve` | same | self-close, recorded *unconfirmed* unless exempt |
| `done` | — | meaning ≈ `lane_submit` (with `--pr/--sha`) or `lane_resolve`, then `team_next` | close your live lane and chain into the brief; says which close it recorded (2026-09-03) |
| `lanes` | `lane_board` | meaning | the board |
| `goal declare/list` | `team_goal_declare` / `team_goals` | same | outcomes above lanes |
| — | `team_goal_outcome`, `team_goal_retract` | **none — the CLI cannot record an outcome or retract a goal** | — |
| `seed list/show/claim/ask/answer/brief/conclude/promote` | `team_seed_list/get/update{claim,ask,answer,submit,promote}` | meaning (`show`↔`get`, `brief/conclude`↔`submit`) | shared ideas before lanes (ADR 291) |
| `report` | `team_report` | same | the insight report at three altitudes |
| `board`, `live` | — | none (browser) | open /board, /live signed in |

### Remembering

| CLI | MCP | twin | question |
| --- | --- | --- | --- |
| `memory show/save/clear` | `team_memory_read/save` | same in meaning; **the MCP prefix says `team_`, the note is seat-PRIVATE** | continuity note (ADR 093) |
| `insight save/search` | `team_insight_save/search` | same | team-visible findings (ADR 327) |
| — | `team_memory_search` | **deprecated alias of `team_insight_search` — it searches insights, not memory** | — |

### Being on the team

| CLI | MCP | twin | question |
| --- | --- | --- | --- |
| `claim [<name>] / --role` | `team_join {as, role}` | meaning | occupy a seat from this folder (ADR 075 "claim handshake") |
| `join <slug> --as <name>` | `team_join` | meaning | occupy a seat, naming the team; **a second CLI verb for the same handshake** |
| `unbind` | — | none | leave this folder's seat, keep it on the team |
| — | `team_leave` | **none — no CLI `leave`; `unbind` is stronger (drops the binding), `availability away` is weaker** | go offline, seat held ~45 s |
| `reclaim <member>` | — | none (admin) | drop someone's stale live session |
| `requests` | — | none (admin) | decide claim requests (ADR 077) |
| `team create/add/remove/archive/export/credential/agent-key/bootstrap/…` | — | none (admin) | the standing roster |
| `agent`, `human`, `role`, `toolkit`, `node` | — | none (admin/provisioning) | — |

### Setup and machine ops — no MCP twin by design

`init wire harness serve service broadcast stream fmt reload reset uninstall reap residency session host audit archaeology`, plus three commands that dispatch but are **absent from the help catalog**: `gate` (the PreToolUse gate, hook-only), `codex-hook` (hook-only), and `surface` (ADR 332 — `surface list/decline/accept`, a human-facing verb nobody can discover from `musterd help`).

## Collisions — one word, two meanings (2026-09-03)

Ranked by how likely a reader is to act on the wrong meaning. Each carries the smallest fix; anything that renames a name others depend on is its own lane.

1. **`nudge` — six things, two directions.** `musterd nudge` (ADR 053) is a *pull*: the seat reads its own inbox at the approval prompt. The reachability nudge (ADR 046) is the same pull after every command. The delivery nudge — `delivery_hint`, `nudge_text`, the `musterd-nudge-relay` skill (ADR 167) — is a *push*: the sender relays a line into the recipient's live session. `session label-nudge` and `session orient-nudge` are hook text telling a fresh session to run a skill. ADR 024 titled the original banner "human reachability nudge". A reader who has just seen `delivery_hint` expects `musterd nudge` to poke a teammate; it prints their own inbox. Falsifier: `musterd nudge --help` vs the relay skill's first sentence say opposite directions. **Fix:** move the command under the answer it belongs to — `musterd inbox --waiting` (read-only, same output) — keep `nudge` as a hidden alias for one release, and re-point the provisioned Notification hook string (nick, 2026-09-03: the hook may move). FIXED 2026-09-03 (lane 01M1MMFSS0): `inbox --waiting` ships, `nudge` is a hidden alias, the Claude Code and Grok Notification hooks run the new form; installed hooks keep working through the alias until `init --refresh-hooks`. ADR 167 keeps the word; it owns it at protocol level. The `session *-nudge` subcommands are hook targets and can rename to `*-prompt` whenever touched.
2. **Closing a lane has four verbs, and `resolve` means two things.** `done` (CLI only), `lane resolve`/`lane_resolve` (self-close, *unconfirmed*), `lane submit`/`lane_submit` (the right one after a merge, ADR 192), `lane ready`/`lane_ready` (deprecated alias). And the act `resolve` closes a *thread* (ADR 025), which `done.ts` itself calls "near-dead". Falsifier: `done.ts`, `lane resolve`, `lane submit` and the deprecated `lane ready` are four CLI entry points that all end in `updateLane`/`recordLaneClose`. **Fix:** delete the `ready` alias on both surfaces (deprecated since ADR 192, 2026-07); make `done` route to `submit` when the lane carries a merge and say *unconfirmed* in its output when it does not. Do not rename the act.
3. **Occupying a seat has three names.** CLI `claim` (from the bound folder), CLI `join <slug> --as` (naming the team), MCP `team_join`. The MCP name matches the CLI verb the docs call secondary; ADR 075 calls the whole thing the *claim handshake*; `requests` decides *claim* requests; and `claim` is also `lane claim` / `lane_claim` / `seed claim`. Falsifier: `join.ts` and `claim.ts` both end in the same `POST /claim`. **Fix:** one CLI verb. Keep `claim` (the handshake's name), make `join` an alias, and add `team_claim` as the MCP name with `team_join` kept as alias — or accept `join` everywhere and rename the CLI. Needs an ADR; the object-qualified `lane claim`/`seed claim` are fine as they are.
4. **`team_memory_*` is private; `team_memory_search` searches something else.** Every MCP tool wears `team_`, so the prefix is a namespace, not a scope — but `team_memory_save` is the one tool where a reader's first guess (shared) is wrong, and `team_memory_search` is a deprecated alias that returns *insights*. Falsifier: `team_memory_save` then `team_memory_search` for the same headline returns nothing. **Fix:** delete `team_memory_search`; add "(seat-private)" to `team_memory_save`/`read` descriptions. No rename.
5. **`reclaim` points both ways.** The command `reclaim <member>` is an admin dropping *someone else's* stale session; `reclaimAgentLease` in the CLI is a session re-taking *its own* lease (ADR 337), and `reap` reclaims orphaned MCP *processes*. Three "reclaim"s, three objects. Falsifier: grep `reclaim` across `packages/cli/src` — three unrelated call sites. **Fix:** comment-level: rename the internal option to `renewAgentLease`; leave the two commands (their objects are in the summary).
6. **`inbox` is five commands.** Read, `--watch` (stream), `--wait` (block for the next act, ADR 054), `--interrupt-check` (a sub-50 ms hook probe, ADR 088), `defer` (ADR 211). The hook probe and the block are not mailbox reads; they are delivery primitives the hooks run. Falsifier: the catalog signature line is the longest in the CLI (nine flags, three verbs). **Fix:** none now — the flags are hook-provisioned strings and renaming them is churn for no reader; document the modes in the summary. Revisit if a sixth mode appears.
7. **`session` and `status` are overloaded but object-qualified.** "Session" is the captured harness session (ADR 131), the session lease (ADR 337), session messaging (ADR 167), and a seat session that can be superseded — all harness sessions, one concept. `status`/`team_status` (roster), `status_update` (act), lane state, derived goal status — every use names its object. No fix.

## Parity gaps (2026-09-03)

- **An agent cannot set its availability** — no MCP twin for `availability`; a seat that wants `away` must shell out. Falsifier: `toolNames.ts` has no availability entry.
- **The CLI cannot record a goal outcome or retract a goal**, and has no `leave`: `team_goal_outcome`, `team_goal_retract`, `team_leave` are MCP-only. Falsifier: `goal.ts` handles `declare|list` only.
- **CLI `status` cannot answer "who is platform?"** — `team_members {role}` (ADR 227) has no CLI form.
- ~~**`surface` is invisible** from `musterd help` though it is the ADR 332 user-facing verb.~~ FIXED 2026-09-03 (catalogued under Setup).

## Help grouping (2026-09-03, `catalog.ts`)

The seven help groups are by implementation, not by question: `whoami memory insight availability wake-context` sit under **inbox** though none reads an inbox; `next`/`done` sit under **work** while `status` (which leads with the same waiting banner) sits under **insight**. "What is waiting for me" is answered from three groups. Falsifier: the `group:` field of those five entries. Fix: regroup as _waiting / talking / work / remembering / team / setup / ops_ — the section order of this page — a docs-only change to `group:` fields.

Checked and NOT a defect: every catalogued command renders a summary and a detail (`musterd help role`, `musterd help reap` verified 2026-09-03); an earlier draft of this page claimed nine empty details from a parser that could not read multi-line strings.

## Recommendation, ranked

1. ~~`nudge` → `inbox --waiting` with alias and hook re-point (collision 1). Own lane, small.~~ DONE 2026-09-03 (lane 01M1MMFSS0).
2. Delete the two deprecated aliases `lane_ready` / `lane ready` and `team_memory_search`; mark `team_memory_*` seat-private (collisions 2, 4). Own lane, small.
3. ~~Catalog repairs: unhide `surface`, regroup by question (help grouping). Docs-only lane.~~ DONE 2026-09-03: `musterd help` has eight rooms by question (waiting / talking / work / remembering / team / insight / setup / ops) and `surface` is catalogued.
4. ~~`done` says *unconfirmed* or routes to `submit` (collision 2). Own lane.~~ DONE 2026-09-03 (lane 01M1MNCZDY): `done --pr --sha` is a submit with the shared routing report; a bare `done` says unconfirmed (or acceptance-exempt); a lane already awaiting acceptance is refused.
5. Seat occupancy gets one name (collision 3). ADR first.
6. Parity: `availability` tool; CLI `goal outcome|retract`, `leave`, `status --role`. One lane, after 5.
7. `reclaimAgentLease` → `renewAgentLease` (collision 5). Fold into whichever lane next touches `resolveRead`.

Related: [what-is-waiting-for-me.md](what-is-waiting-for-me.md) (the four "waiting" surfaces are two), [musterd-cli-messaging.md](musterd-cli-messaging.md).
