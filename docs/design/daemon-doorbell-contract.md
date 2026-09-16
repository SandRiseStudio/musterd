# The daemon doorbell contract — what a harness adapter owes a directed act

> **Status: ADR seed, 2026-09-14.** The output of huddle `01M2GASFNZSZT0NV0HPV5EJFBA` on lane
> `01M1T41M7MQKVSEV8TEES0NHQB` — schmidt opened it with a six-clause draft and every harness in the
> room answered from its own configuration on daemon `c8e89dd8`: cursor (schmidt), grok (wanderer),
> claude-code (izzo, recorder), opencode (ghost), codex (big-body), native musterd (ryder, two
> sessions). delta, a woken cloud seat outside the room, closed one unmeasured row and supplied a
> falsifier. Every claim below carries the date it was measured and the seat that measured it; the
> per-harness table is the record, the reworded clauses are the proposal. Clause 8 was added after
> the huddle closed, from measurements made the same day. Clause 7 landed as ADR 088 amendment 3.
> Nothing else here is decided until an ADR cites it.

## The question

A directed act — a `steer`, a `request_help`, an `ask`, a huddle turn addressed by name — has to reach
a model that is **busy**: mid-loop, making tool calls, not reading its inbox. The daemon composes
one line for it. The contract is what every harness adapter must do so that line lands in **model
context**, not in a debug log, a stdout nobody reads, or a hook whose output the harness discards.

Schmidt's draft, as opened (verbatim, six clauses):

1. probe at every tool boundary with `musterd inbox --interrupt-check` on a channel that reaches
   the MODEL, not the debug log;
2. an idle/stop rail when there are no boundaries;
3. a live Presence lease, persisted where the CLI hook reads it;
4. a generation stamp the doctor can see drift on;
5. `musterd init --refresh-hooks` as the only writer;
6. the one-line notice headlined by class.

Each rep was asked to say first **how they learned of their own turn** — (a) injected at a tool
boundary, (b) their own inbox check, (c) a human nudge — because that answer is the contract's
live test, taken on the harness under discussion, in the session doing the discussing.

## How each turn actually arrived

| seat | harness | learned of the turn by | what that measured |
| --- | --- | --- | --- |
| schmidt | cursor | (c) nick in chat | idle at the prompt, Cursor fires no hooks — nothing can ring until a human prompts |
| wanderer | grok 1.0.13 | (a) PreToolUse `additionalContext` | first live ring; two deaf probes before `team_join` |
| izzo, turn 1 | claude-code | (b) own inbox check after the orient skill | two PostToolUse probes fired before it and were **refused** (dead lease) |
| izzo, turn 2 | claude-code | (a) `PostToolUse:Bash hook additional context` | first live ring, after a native call |
| ghost | opencode 1.18.29 | (a) plugin fence on a bash result | first live ring; every probe before and since refused (33 rows, lease dead) |
| big-body | codex | (b) own `musterd inbox` — a 589-item read | multiple native calls afterwards, no fence: codex has no probe |
| ryder (session 1) | native musterd, read from a claude-code seat | (b) own inbox check | seam was live and rang at every boundary — the **wrong thing** (see clause 7) |
| ryder (session 2) | same | (c) nick typed "check messages" | same stale ring, ~14 boundaries |
| delta | claude-code, woken VM seat | — not in the room | rang after `mcp__musterd__*` calls too; a steer rang ~20 times after it was acted on |

Two of nine arrivals were the doorbell working as intended. Three were the human. The rest were
the seat finding its own turn by reading, which is the thing the doorbell exists to make unnecessary.

## The six clauses, harness by harness

Verdicts: **holds** / **partial** / **fails** / **not shipped** / **exempt** (nothing to test) /
**unmeasured**. A clause that cannot apply to a harness is recorded as such, not scored — ryder's
point, and the table is wrong without it.

### (1) A model-reaching seam

| harness | verdict | the seam that reaches the model | measured |
| --- | --- | --- | --- |
| cursor | holds mid-turn | `postToolUse` → `musterd session observe --stdin --interrupt` → `system_reminder` | schmidt, 2026-09-14 |
| grok | holds, one seam only | `PreToolUse` `additionalContext`. PostToolUse stdout **and** additionalContext are discarded | wanderer, 2026-09-03 (falsify: a PostToolUse canary in `chat_history.jsonl`) |
| claude-code | holds | `PostToolUse` stdout → `PostToolUse:<Tool> hook additional context`, after **native and MCP** calls alike | izzo native 2026-09-14; delta MCP (`team_join`, `team_inbox_check`, `lane_board`, `team_send`, `lane_update`) 2026-09-14 |
| opencode | holds at native boundaries only | ADR 392 plugin `tool.execute.after` fence. Zero fences across ~15 MCP calls in the same window native fences arrived | ghost, 2026-09-14 |
| codex | **holds in unit; live unmeasured** | `PostToolUse` runs `musterd codex-hook post-tool-use --stdin`, writes `model_observed`, then performs the lease-authenticated interrupt read. A raised line becomes exactly `hookSpecificOutput.additionalContext`; quiet/refused/error cases emit nothing. No Stop or idle rail. | ADR 397 focused hook tests, 2026-09-15. The authorized Codex 0.154.0 Surface was uncallable from a different adapter checkout, so live model delivery remains unmeasured. |
| native | **holds** (seam shipped 2026-09-14, lane 01M2GNYGEY; read half live 2026-09-16, lane 01M2GQG86D; append half live 2026-09-16, lane 01M2P5B3RE) | `bridgeTools` asks `MusterdClient.interruptCheck()` after every bridged tool call and `appendInterrupt` appends the daemon-composed line to that tool result. Delivery is provable from the daemon side: the line is in the turn's `wake_turns` capture row — **by accident of the capture path, not by design** (lane 01M2NH5WT9) | ryder, 2026-09-14, `nativeBridge.ts` / `nativeInterrupt.test.ts`. **Not** the `onBeforeTurn` push this row originally proposed: `BetaToolRunner.pushMessages` sets the runner's private `#mutated`, and the iterator appends the assistant message only `if (!this.#mutated)` — injecting from inside the `for await` body drops the turn the model just took and no tool then runs (@anthropic-ai/sdk 0.116.0, pinned as a regression fixture). **Read half, izzo 2026-09-16:** both branches of the daemon read hold on a real seat credential + session lease against the laptop daemon — silent `200 {"raised":false}` at 16:24:51Z on `fb283e5c`; raised line caught verbatim from ~18:24Z, `⚡ musterd: acceptance from sloane (ask) — run 'musterd inbox' to read it.` (delivered by a claude-code hook, not a native loop). **Append half, izzo 2026-09-16, the woken-native-seat measurement (lane 01M2P5B3RE):** seat `compo` enrolled `harness: musterd` on a private host label (`izzo-probe`, its own `MUSTERD_HOST_REGISTRY` so the resident LaunchAgent host never saw the order), woken by one `musterd host --once` that nick ran with the model credential sourced into that process alone (`MUSTERD_MODEL=claude-sonnet-5`, daemon `501c767`). Lease `01M2P61TE9AZ0PG7GQ6M79SJDA`, wake due 22:40:27Z, roster-verified occupancy 5.1 s, 6 turns, $0.4351, wall 39.3 s. nick sent one `steer` at 22:40:34Z; the daemon raised it at 22:40:38Z (`interrupt.raised`, actor nick, target compo) and the same second it rode the tool result of turn 3 (`wake_turns` row `01M2P6257K3QVSGPSTT2VJ008Q`, a `team_inbox_check` result) verbatim: `⚡ musterd: steer from nick (steer) — run 'musterd inbox' to read it.` The loop's next call was an inbox read that rendered the steer (`inbox.rendered` 22:40:43Z) — the line reached model context and moved the model, mid-loop, ~4 s after send. Turn 1 carried a second line, `⚡ musterd: urgent from izzo (message) — run 'musterd inbox' to read it.`: the act the seat was woken FOR (an old urgent message, `01KZVTZSHGFZ4ME63WZZTJN5CA`) rang once at the first tool boundary and was discharged by the turn-2 inbox read — clause 7 holding, not the ryder-session-1 every-boundary ring. Two defects the same run exposed, neither in this seam: the woken seat's first call, `team_wake_context {act_id:"latest"}`, came back `forbidden wake context target` (the tool takes a real act id and the wake brief never handed it one), and the delivered line's instruction — run the inbox — put a seat with 6,231 unread into a haystack where the steer was rendered but never acted on (no `team_members` call, no acknowledgement). Observed outranked declared exactly as ADR 158 says: the model's own status_update claimed `gpt-5.1`, the daemon attested `claude-sonnet-5` from the environment. Falsify: enroll any offline seat `--harness musterd` on a private host label, wake it with a directed act, send a `steer` while `wake_turns` is still growing, and find no row whose transcript contains `⚡ musterd: steer from` |

Six harnesses, four different seams, two with none. **"Every tool boundary" holds nowhere** and
would pass two configurations that never reached a model (grok's 2026-09-02 PostToolUse hook;
codex's present one).

### (2) A rail when there are no boundaries

Split into what the room found are two different things: an idle **detector** (does anything fire
when the model goes idle?) and idle **delivery** (does what fires reach the model?). Idle at the
prompt waiting on a human is a third row.

| harness | detector | delivery | idle-at-prompt |
| --- | --- | --- | --- |
| cursor | none | none | deaf until a human prompts |
| grok | `Stop` at `end_turn` | yes — blocks once with the daemon-composed line | deaf |
| claude-code | `Notification` → `musterd inbox --waiting` | **no** — Notification stdout never enters model context. The machine-wide `UserPromptSubmit` nudge reaches the model, but only after the human has typed | deaf |
| opencode | `session.idle` → `promptAsync` (synthetic, capped at 4) | half-measured — silent-with-live-lease confirmed live (no spurious prompt); deaf lease rings a deaf notice *as a turn* by code reading; raised-while-idle still unmeasured, inherits the #21524 race (ghost, 2026-09-14, eval §9b) | unmeasured |
| codex | none | none | deaf |
| native | **no idle state** | — | cannot occur: a native occupancy runs from the composed line to `end`, `settled` closes the bridge and drops presence. The rail is a **new wake** (ADR 131), which is the actuator's job |

**No harness in the room covers idle-at-prompt-waiting-on-a-human without an external wake
actuator.** Unanimous. Native is the only row where that gap is structurally absent, and only
because there is no prompt to wait at.

### (3) A Presence lease the probe can authenticate with

The weakest clause on the board. It failed the same day for two **different** reasons, and the
harness that holds it by construction shows the clause was written around one implementation.

| harness | verdict | what was measured |
| --- | --- | --- |
| cursor | holds | lease persisted to `binding.json` on occupy and renewal (#1348, #1369) |
| grok | holds only via MCP `team_join` | **writer failure:** `musterd claim wanderer` mints a lease that dies with the command; `--detach` writes none. Session started deaf on that path (wanderer, 2026-09-14) |
| claude-code | holds only via MCP `team_join` | same writer failure, reproduced verbatim: two probes refused before `team_join`, live after (izzo, ryder, delta — three seats, 2026-09-14). **Woken seats are structurally deaf on the wake path**: the actuator spawns with `--allowedTools mcp__musterd` and the musterd tools arrive deferred, so `team_join` cannot be called until a `ToolSearch` round-trip has been spent (delta) |
| opencode | **fails** with a fresh lease | **lifetime failure:** re-occupy at 09:17 PT wrote `binding.json`, dual `ws_close` 51 s later, every probe since refused — `reap_offline` then 33 `interrupt_probe_refused` rows. #1369 closed the post-bounce window; the reaper + reconnect path is a different hole (ghost, 2026-09-14; lane `01M2GBPX2S`, izzo) |
| codex | not satisfied by the session | the session exposed no `team_*` tools and resolved as `cli · binding`; a one-shot CLI inbox can read, but that is not a churn-surviving Presence (big-body) |
| native | **holds by construction** | writer and reader are the same object: `MusterdClient` over `InMemoryTransport`, autojoin on the first tool call (ADR 108), presence in memory, nothing written to a file because no other process reads one. Neither falsifier can occur: no one-shot, no socket between reader and writer. Native's own tension is different — the lease is bound to the **loop**, which outlives verification, which is why `POST /residency/wake-turn` is deliberately not lease-gated (ADR 251 note); and a `reap_offline` mid-loop would leave a running loop deaf with no file for anyone to inspect (ryder) |

### (4) Drift the doctor can see

| harness | verdict | what the doctor compares |
| --- | --- | --- |
| claude-code | **holds — the reference** | `inspectClaudeHookDrift` compares installed command **text** against what this build would write, for every local hook (ADR 168: presence is explicitly not the question). The two machine-wide hooks carry `FEATURE_EPOCH` with a **two-way verdict**: older → run `musterd init --refresh-hooks`; **newer than this checkout** → the hook is fine, the checkout is behind, do **not** run init or every folder on the machine is downgraded. Fired live this session ("provisioning is behind what this build writes", ADR 171) |
| cursor | holds | `inspectCursorHookDrift` (#1350) detects missing/stale `--interrupt` command text |
| opencode | holds | marker-owned plugin; doctor names missing or STALE |
| grok | **holds** (unit tests + live probe) | `inspectGrokHookDrift` compares installed command **text** against what this build would write and stamps `FEATURE_EPOCH` with the two-way verdict (ADR 168). A same-marker PreToolUse that discards stdout is STALE; a newer epoch blames the checkout and forbids init. Tombstone consulted only for MISSING (ADR 332) — a declined event does not silence STALE. Leftover PostToolUse still named. Fired against a scratch worktree 2026-09-14 (delta PROBE A/B/C on `9b7b4baf`; wanderer declined+stale after). (lane 01M2GP1FNA) |
| codex | **holds (unit)** | `inspectCodexHookDrift` compares the exact marker-owned event/type/command set, including `FEATURE_EPOCH`, in both workspace and git-common-dir copies. Missing, older, text-different, or duplicate owned handlers prescribe `musterd init --refresh-hooks`; a newer epoch says the checkout is behind and forbids a downgrade rewrite. (ADR 397) |
| native | **exempt** | `nativeMcpConfig` sends `epoch: FEATURE_EPOCH`, `markerGeneration: 'native'` from the build that runs the loop (`nativeBridge.ts:93,103`). Nothing is installed, so nothing can drift and nothing can be doctored. Real drift for native is host build vs daemon build, which no `inspect*` looks at (ryder) |

### (5) `musterd init --refresh-hooks` as the only writer

Holds for cursor, grok, claude-code, opencode, codex — marker-delimited entries, non-musterd
handlers preserved, removal marker-exact. **Exempt** for native: nothing installed, nothing to own.

### (6) The one-line notice headlined by class

Holds wherever (1) delivers: cursor, grok, claude-code, opencode measured it this session. Codex
holds in the focused seam test but remains live-unmeasured because its evaluated Surface was
uncallable; the daemon still composes the headline. Native held it
**at wake only** (`spec.order.composed_line` is the whole prompt the loop starts with) until its
clause-1 seam shipped; mid-loop it now emits the daemon's line verbatim, never a locally composed one.

And it is where the room found the contract's missing clause, because a notice can be perfectly
formed, perfectly delivered, and **wrong** — see (7).

**A third way to be wrong, repaired 2026-09-16 (stanley, lane `01M2P69FHZ`).** The headline was
right, the delivery held, the act was not stale — and the notice still failed, because its tail
(`run 'musterd inbox' to read it`) named an unbounded read. On compo at 6,231 unread the model
obeyed it exactly and the steer it was rung about was five lines of a 32 KB result: rendered, never
acted on, and — by clause 7 (iv) — discharged by that very read. `composeInterruptLine` now names
the act id and a by-id read in both spellings (`team_inbox_check {ids:["<id>"]}` /
`musterd inbox --id <id>`), so the follow-up is one call at any inbox size. ADR 088 Amendment 4.
Not a new clause: what a notice should POINT AT sits inside (6), and this document arms nothing.

## What the room would change — the clauses reworded

Stated as obligations, not mechanisms (ryder's framing, which the codex and native rows require: a
contract that names a hook is CLI-shaped and makes the best case unrepresentable).

**(1) Reach.** A raised act reaches model context by the next tool boundary, on a seam **named and
measured per harness** — the seam whose output is proven to enter model context, not "every tool
boundary". The record for a harness names the seam (claude-code: PostToolUse stdout; grok:
PreToolUse additionalContext only; cursor: postToolUse system_reminder; opencode: plugin fence,
native calls only) and the canary that measured it. A harness with no measured seam is recorded
**not shipped**, never "supported".

**(2) Rail.** Split three ways. An idle **detector** and idle **delivery** are scored separately —
claude-code has the first without the second and that is a fail, not a partial. When the harness
has **no idle state**, the daemon's wake actuator **is** the rail and the row says so rather than
failing it. Idle-at-prompt-waiting-on-a-human is named as its own row and recorded honestly: today
no harness covers it without an external wake.

**(3) Lease.** Not "persisted where the CLI hook reads it" — that writes one implementation into
the clause. Instead: *a Presence lease whose lifetime is the occupancy's, readable by whatever
process probes, that dies with the session and not before.* In-memory satisfies it. A file satisfies
it only if the **writer** is the adapter (not a CLI one-shot — grok, claude-code, 2026-09-14) and
the **lifetime** survives reaps and socket churn (not merely written at occupy — opencode,
2026-09-14). Both falsifiers are recorded against the clause.

**(4) Drift.** Adopt the claude-code definition verbatim for every harness that installs
something: exact command-**text** comparison, plus a generation stamp with the two-way
older/newer verdict. A doctor that sees only marker presence is not clause (4). A harness that
installs nothing is **exempt** and recorded exempt — otherwise the tally reads "4/5 hold" for a
clause one of the four never faced. Two obligations, not one: "the doctor can see drift" (installed
hooks) and "the daemon can see the generation" (native's connection stamp).

**(5) Writer.** Unchanged. Exempt where nothing is installed.

**(6) Notice.** Unchanged in form; conditional on (1).

**(7) Discharge — the clause the draft did not have.** Six clauses govern delivery and none governs
what stops ringing. Two independent falsifiers, different seats, different obligation shapes, same
day:

- **ryder, 2026-09-14, daemon c8e89dd8:** ask `01M1N2DDRY` (species approve, tier standard) on lane
  `01M1MM1Y` — done, merged as #1265 / e1d3aaa3 on 2026-09-03 — rang at **every** tool boundary of
  two sessions, eight days on. The daemon contains #1361 (`baa058bd`, "interrupt-check sees this
  seat's own accept"); it did not help because ryder never sent an accept — the obligation was
  discharged by the lane reaching done and by another addressee, neither of which moves the cursor.
  Meanwhile schmidt's huddle turn, addressed to ryder by name, **never headlined once**: the seam was
  live, the cursor was pinned, and a live seam with a stuck cursor is indistinguishable from a deaf
  one at the model — while reading as PASS on all six clauses.
- **delta, 2026-09-14:** stanley's steer `01M2GC25MN` rang at ~20 boundaries of one session and
  every boundary of a second, across a fresh `team_join` and a threaded `reply_to` on the steer
  itself — after delta had read it at boundary 3, acted on it, and finished the lane. A steer has no
  accept/decline/resolve; it is not an obligation you answer but one you act on, so no move the
  addressee can make discharges it.

The bell that rings the wrong thing at every boundary teaches the model to ignore the bell, which
defeats all six clauses at once. Proposed: **the interrupt cursor advances on any of** (i) this
seat's own accept/decline/resolve (#1361, shipped); (ii) the referenced lane leaving
`awaiting_acceptance`; (iii) a co-addressee's accept discharging a multi-addressee ask; (iv) **read
by the addressee, for any act with no answering move** — steer, status_update, plain message.
Falsifiers for (ii)/(iii) are ryder's; for (iv), delta's. Both live on c8e89dd8.

**(8) Callable, not merely granted — clause 1's unwritten sibling (added 2026-09-14, after the
huddle closed).** Clause 1 is the bell reaching the model; this is the model being able to
**answer**. In Claude Code the musterd tools arrive **deferred**: only their names are in the
prompt, and a `ToolSearch` round-trip must fetch each schema before any `mcp__musterd__*` call
succeeds — and after an MCP server drops and reconnects mid-session, every schema has to be fetched
again, with no permission change and nothing on the roster or in the doctor to show for it. A seat
can hold a live lease (3), take a probe that lands in context (1), read a one-line notice (6), and
still be unable to `team_send` without a `ToolSearch` it does not know to make: three clauses green,
seat functionally mute. Unlike a permission refusal, deferral raises no error.

Measured three times the same day, none of them on the path it was first attributed to: stanley on
the woken cloud seat (16:35Z, first written as a cloud-seat property); ryder in an interactive
laptop session, including the re-fetch after an MCP reconnect (18:43Z); izzo, this seat, whose first
act of the session was a `ToolSearch` for the inbox tools before it could orient. Falsify: a session
whose first `mcp__musterd__*` call succeeds with no preceding `ToolSearch`. Record: `docs/perf/cloud-seat.md`
finding 18a and `docs/wiki/cloud-seat-from-inside.md` (stanley, #1386).

Proposed wording: *the probe must reach the model **and** the tools it names must be callable when
the model reads it; a harness with a tool-deferral path satisfies neither by grant alone, and a
reconnect can revoke callability without revoking the grant.*

| harness | verdict | what was measured |
| --- | --- | --- |
| claude-code | **defers & re-defers** | musterd tools arrive deferred; schema fetched via `ToolSearch` (stanley, izzo, ryder). MCP drop/reconnect mid-session drops schema cache; every schema must be fetched again with no permission error (ryder alone, 2026-09-14) |
| cursor | **fails on reconnect** | dynamic tool discovery via `GetDynamicTools` / `CallDynamicTool`. Stdio MCP drop mid-session leaves schema catalog cached but execution severed (`Error: Tool execution error. Not connected`). No in-conversation recovery; seat is permanently mute on dynamic tools until window reload (schmidt, 2026-09-14; `docs/wiki/cursor-agent-live-doorbell-eval.md` Check 5) |
| grok | **defers**; reconnect unmeasured | musterd tools are not in the base tool list; schema fetched via `search_tool` then invoked with `use_tool` (`musterd__team_*` / `musterd__lane_*`). Analog of Claude Code `ToolSearch`. MCP drop/reconnect mid-session unmeasured (wanderer, 2026-09-14, this session; falsify: a Grok session whose first `musterd__*` call succeeds with no preceding `search_tool`) |
| opencode | **no deferral; fails on reconnect** | granted tools arrive in context with schemas, directly callable — first `musterd_team_*` calls of a 1.18.31 session succeeded with no discovery round-trip (ghost, 2026-09-14; eval §9a). SIGTERM to the stdio MCP child mid-session evicts the tools from the catalog (`unavailable tool`, zero MCP tools listed) with no in-turn or cross-turn recovery; the SAME session recovers after a serve restart (eval §10) |
| codex | **unavailable in the evaluated configuration** | An authorized `codex-cli 0.154.0` run attempted `team_inbox_check` as its first action, with no discovery action, and found no callable musterd tool. Its enabled MCP entry resolved to a different checkout's adapter build. This is not evidence of a deferral mechanism or reconnect behavior; both remain unmeasured. See `docs/wiki/codex-live-doorbell-eval.md`. |
| native | **exempt** | bridge owns tool table in memory (`MusterdClient`); no discovery step, no stdio disconnect (ryder) |

The woken-seat case is the sharpest: the actuator spawns with `--allowedTools mcp__musterd`, so the
wake brief's own instruction ("orient via `team_wake_context`") is one `ToolSearch` away from
working, and every boundary before that is guaranteed deaf (clause 3, delta).

## What is open, and who carries it

- **Lane `01M2GBPX2S` (izzo, high):** the opencode lease refused after `reap_offline` + `ws_close`
  with a fresh `binding.json` — the clause-3 lifetime failure. Acceptance is a reconnect-after-reap
  that answers probes with no manual `team_leave`/`team_join`, a regression covering it, and a log
  that tells "refused because dead" from "refused because reaped".
- **Clause 7 — lane `01M2GJFCQV` (izzo), landed the same day as ADR 088 amendment 3:** (ii) lane
  state, (iii) co-addressee answers fetched by reference, (iv) `inbox.rendered` on read plus the
  addressee's own reply. ryder's ask and delta's steer are the regression fixtures.
- **Codex live delivery remains unmeasured:** ADR 397 ships the bounded PostToolUse seam and unit
  proof, but the authorized Codex 0.154.0 Surface resolved a different adapter checkout and could
  not call musterd. A correctly wired disposable run must record callability and model delivery;
  it must not imply an idle or reconnect rail.
- ~~**Native's seam is one function away**~~ **Shipped** (ryder, lane 01M2GNYGEY, 2026-09-14) — in
  the bridge rather than on the engine seam, for the runner reason recorded in the clause-1 row.
  ~~Native is now the reference row: the only harness that can prove delivery from the daemon side.
  Still owed: a live arm. Every claim above is from unit tests; no woken native seat has yet
  received a raised act through it.~~ **Downgraded 2026-09-16** (izzo, lane 01M2GQG86D): the
  daemon read half is live-confirmed on a real seat (both branches, verbatim line in the clause-1
  row); the append half and the `wake_turns` proof are **not**, and cannot be on this machine until
  the actuator carries a model credential and `team add` can mint a seat again (lane
  01M2NR7N9V). "Reference row" was true of the capture path, not of the evidence — the line lands
  in `wake_turns` because `appendInterrupt` folds it into a tool result, not because delivery is
  recorded anywhere (lane 01M2NH5WT9 proposes recording it for every rail). The measurement trap
  that ate two attempts at this arm is written up once in
  [the instrument discharges the act](../wiki/the-instrument-discharges-the-act.md).
  **Measured 2026-09-16** (izzo, lane 01M2P5B3RE, nick at the keyboard): the append half holds on a
  woken native seat — a `steer` sent mid-loop rode the next tool result four seconds later and is
  in the lease's `wake_turns` row (clause-1 row has the ids). Neither blocker needed the fix it was
  waiting for: the LaunchAgent stayed keyless and no seat was minted — a private
  `MUSTERD_HOST_REGISTRY` plus a private host label let one `host --once`, run by a human with the
  credential in that process alone, own the order. Native is now the one row whose delivery the
  daemon can prove from its own capture. The two things that run found wrong are lanes, not this
  seam: the wake brief's `team_wake_context` call is refused, and "run 'musterd inbox'" is the wrong
  instruction for a seat with thousands unread.
- **Opencode's idle rail is half-measured** (ghost, lane `01M2GP0QM3`, 2026-09-14, eval §9b):
  silent-with-live-lease confirmed live (no spurious prompt — the `if (!line) return` path);
  deaf-lease rings a deaf *notice as a synthetic turn* by code reading (the bug to fix, not the
  bell to trust); raised-while-idle delivery still unmeasured (no idle window; inherits the
  #21524 204-with-no-turn race). The canary that covers detector and delivery at once: idle
  with a raised line.
- ~~**Grok and codex doctors** need the clause-4 text comparison and epoch that claude-code and
  cursor already have.~~ **Grok clause 4 shipped** (wanderer, lane 01M2GP1FNA, 2026-09-14); **Codex
  clause 4 shipped in unit** (ADR 397, 2026-09-15).
- **Clause 8 — lane `01M2GP2Z90` (schmidt, Cursor evaluation landed):** Cursor measured live. Dynamic
  tools require `GetDynamicTools` discovery before `CallDynamicTool`; on MCP stdio drop/reconnect
  mid-session, Cursor does not reconnect the stdio process, returning `Error: Tool execution error. Not connected`
  while schema catalog remains populated. Permanent mute on dynamic tools until window reload.
  Claude-code defers and re-defers; grok defers behind `search_tool`/`use_tool` (reconnect unmeasured);
  opencode does NOT defer (tools in context, first call direct — ghost, 2026-09-14, eval §9a)
  but FAILS on reconnect (stdio drop evicts the catalog, mute until serve restart, same session
  recovers — eval §10, lane `01M2GS6Q4`); codex remains open for its harness owner.

## What this does not decide

Whether the seven clauses become an ADR, and which of the open lanes are worth their cost against
the alternative the room kept returning to: a human at the keyboard, which delivered three of the
nine turns above. Nothing in this document is armed.
