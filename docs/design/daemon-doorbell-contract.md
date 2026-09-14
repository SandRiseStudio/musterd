# The daemon doorbell contract — what a harness adapter owes a directed act

> **Status: ADR seed, 2026-09-14.** The output of huddle `01M2GASFNZSZT0NV0HPV5EJFBA` on lane
> `01M1T41M7MQKVSEV8TEES0NHQB` — schmidt opened it with a six-clause draft and every harness in the
> room answered from its own configuration on daemon `c8e89dd8`: cursor (schmidt), grok (wanderer),
> claude-code (izzo, recorder), opencode (ghost), codex (big-body), native musterd (ryder, two
> sessions). delta, a woken cloud seat outside the room, closed one unmeasured row and supplied a
> falsifier. Every claim below carries the date it was measured and the seat that measured it; the
> per-harness table is the record, the reworded clauses are the proposal. Nothing here is decided
> until an ADR cites it.

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
| codex | **fails** | `PostToolUse` runs `musterd codex-hook post-tool-use --stdin`; `observeModel` writes `model_observed` and never calls `--interrupt-check`. ADR 249's "existing low-cost interrupt check" is not in the implementation | big-body, 2026-09-14, from `.codex/hooks.json` and source |
| native | **not shipped** | there is no hook because there is nothing to bridge — the loop owns the message array and every tool result. `EngineRunSpec` is output-only (`onTurn`, no inbound counterpart). One function in `nativeBridge` — append the composed line to the next tool result when raised — and the seam is guaranteed model-reaching, provable from the daemon side via the `wake_turns` capture rows | ryder, 2026-09-14, `native.ts` / `nativeBridge.ts` / `engine.ts` on c8e89dd8 |

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
| opencode | `session.idle` → `promptAsync` (synthetic, capped at 4) | unmeasured — no idle window occurred. A refused probe still prints, so the first idle may ring a deaf notice rather than a turn | unmeasured |
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
| grok | partial | `inspectGrokHookDrift` names missing markers and a leftover PostToolUse; does not compare command text; no generation stamp. A stale PreToolUse that still carries `musterd-grok-interrupt` but discards stdout passes (wanderer) |
| codex | partial | required event/subcommand plus static marker v2, including the git-common-dir copy — but `healthy()` is substring checks, no full-text comparison, no epoch. A same-marker stale command passes (big-body) |
| native | **exempt** | `nativeMcpConfig` sends `epoch: FEATURE_EPOCH`, `markerGeneration: 'native'` from the build that runs the loop (`nativeBridge.ts:93,103`). Nothing is installed, so nothing can drift and nothing can be doctored. Real drift for native is host build vs daemon build, which no `inspect*` looks at (ryder) |

### (5) `musterd init --refresh-hooks` as the only writer

Holds for cursor, grok, claude-code, opencode, codex — marker-delimited entries, non-musterd
handlers preserved, removal marker-exact. **Exempt** for native: nothing installed, nothing to own.

### (6) The one-line notice headlined by class

Holds wherever (1) delivers: cursor, grok, claude-code, opencode measured it this session. Codex and
native: **blocked on (1)** — the daemon composes the headline; the harness cannot deliver it. Native
holds it **at wake only**: `spec.order.composed_line` is the whole prompt the loop starts with.

And it is where the room found the contract's missing clause, because a notice can be perfectly
formed, perfectly delivered, and **wrong** — see (7).

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

## What is open, and who carries it

- **Lane `01M2GBPX2S` (izzo, high):** the opencode lease refused after `reap_offline` + `ws_close`
  with a fresh `binding.json` — the clause-3 lifetime failure. Acceptance is a reconnect-after-reap
  that answers probes with no manual `team_leave`/`team_join`, a regression covering it, and a log
  that tells "refused because dead" from "refused because reaped".
- **Clause 7 — lane `01M2GJFCQV` (izzo), landed the same day as ADR 088 amendment 3:** (ii) lane
  state, (iii) co-addressee answers fetched by reference, (iv) `inbox.rendered` on read plus the
  addressee's own reply. ryder's ask and delta's steer are the regression fixtures.
- **Codex has no interrupt seam** and ADR 249 says it does. Someone owns making the document match
  the code or the code match the document.
- **Native's seam is one function away** (`onBeforeTurn` on the engine seam plus one bridge call);
  ryder offered to take it as a lane. Once shipped, native is the reference row: the only harness
  that can prove delivery from the daemon side.
- **Opencode's idle rail is unmeasured** (`session.idle` never fired); the first idle may ring a
  deaf notice rather than a turn — a canary is needed.
- **Grok and codex doctors** need the clause-4 text comparison and epoch that claude-code and
  cursor already have.

## What this does not decide

Whether the seven clauses become an ADR, and which of the open lanes are worth their cost against
the alternative the room kept returning to: a human at the keyboard, which delivered three of the
nine turns above. Nothing in this document is armed.
