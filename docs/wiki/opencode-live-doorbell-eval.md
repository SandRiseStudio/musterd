# OpenCode live-doorbell eval

OpenCode live-doorbell evaluation: measuring interrupt reach, peer inject, and turn-continuation on 1.18.27 (lane `01M1MK8NGYXW2YJ95PYRW8XERY`).

Same eval as the Grok live-doorbell (wanderer lane `01M1MC0M6M8RWV6RQFRPASNVQD`) and the
Cursor-agent live-doorbell (schmidt lane `01M1MFD7PW9TM5JNHWW2J1PC9J`), for the OpenCode
harness. Question: how do we get a doorbell into a LIVE OpenCode transcript in seconds
(model sees it), without inventing an identityless inject — no session-file writes, no TTY
stdin.

Observed 2026-09-03 by ghost on lane `01M1MK8NGYXW2YJ95PYRW8XERY`, verified against
opencode **1.18.27** (docs current Sep-2026, `@opencode-ai/plugin` 1.18.27 type surface,
one headless live measurement). Short version: **OpenCode is the only harness of the four
with a documented, server-mediated peer-inject rail** — and it was measured working both
halves (persist + wake) on 1.18.27. The gaps are port discovery and upstream wake-race
history, not missing API.

## 1. Documented peer inject: YES — richest of the four harnesses

CCD has `list_sessions`+`send_message`; Grok 1.0.13 has nothing; Cursor has nothing.
OpenCode documents a full HTTP rail (`/docs/server`, `/docs/cli`):

- `POST /session/:id/message` — send a message and wait for the response (sync inject).
- `POST /session/:id/prompt_async` — send a message asynchronously, returns 204 (the
  doorbell primitive). Body carries `noReply` and per-part `synthetic` flags.
- `POST /session/:id/abort` — abort a running session (the interrupt half).
- `GET /session/status` — busy/idle per session (idle sessions are absent from the map).
- `POST /tui/append-prompt` + `POST /tui/submit-prompt` — drive a live TUI's prompt box
  (the IDE-plugin pattern). Human-mediated, not an agent doorbell; listed so nobody
  re-discovers it as one.
- `GET /event` — SSE bus (`server.connected` first), for watching `session.idle` from
  outside the process.

**Measured live, 1.18.27, headless `opencode serve` on a scratch port with an isolated
`XDG_DATA_HOME` (real DB untouched):** created session → `prompt_async` with
`noReply:true` → **204, persisted as a `user` message, readable via message list**
(persist half: FOUND IT). Then `prompt_async` with reply on the idle session → **the
assistant loop scheduled and ran a real 2-step turn** (step-start/tool/read calls,
~11k input tokens) — wake half: FOUND IT, once. `abort` on the idle session → `true`,
200, harmless. Scratch session aborted, deleted, server killed afterwards.

Falsify the wake half: repeat the reply-mode `prompt_async` against an idle 1.18.x
session and watch for 204-with-no-turn.

## 2. Tool-boundary hook → MODEL: yes, two paths, one load-bearing caveat

- **`tool.execute.after`** mutates `{title, output, metadata}` **in place** (fired from
  `session/prompt.ts`; the never-triggered report in #25918 was corrected in-thread to
  "fires in prompt.ts, native-tool path"). Community proof it reaches model context:
  `opencode-command-hooks` injects hook output "directly into context for your agent to
  read"; `oh-my-opencode` runs a dozen after-hooks that mutate output.
- **Caveat (load-bearing for musterd):** on the MCP-tool path the hook fires with the
  raw `CallToolResult` and text assembly happens *after* it (#21149, audited at
  1.14.x) — so output mutation may not reach the model for MCP tool calls, only native
  ones. Musterd seats talk to the model **through MCP tools**. Re-verify on 1.18.x
  source before building an interrupt-check append on this hook.
- **Stronger path:** `experimental.chat.messages.transform` fires per LLM request
  (`session/prompt.ts:1587`, including mid-turn continuations) and
  `experimental.chat.system.transform` fires at prompt construction (`session/llm.ts`).
  A plugin can splice interrupt-check output into either on every request. Gotchas, all
  documented in upstream issues, none on the plugins page (#33025, closed not_planned):
  mutate the array **in place** (`splice`/`push`) — reassigning `output.messages` is a
  silent no-op (#25754); `messages.transform` input is `{}` (no sessionID — global
  scope only); both hooks are `experimental` and undocumented, i.e. version-pinned or
  rotting (same coupling ADR 362 finding 3 names).
- Terminal-only, for contrast: `tui.toast.show` / `client.tui.showToast` (the notify
  analog — never model-facing), `permission.ask` (flow decision, not message text).

## 3. Stop-hook equivalent: YES, demonstrated in the wild

`session.idle` event + in-process `client.session.prompt` is the turn-continuation
shape, and `jasonbhart/opencode-code-review-plugin` ships exactly it: on idle-after-edit
it runs a review command, then `client.session.prompt({path, body:{parts}})` injects
`**Code Review Feedback**…` **as a reply-triggering turn**, and mirrors to a parent
session with `body.noReply:true` and part-level `synthetic:true` (**transcript-only**:
model reads it next turn, no turn now). Loop guard is the plugin's own (`isReviewing`
flag + debounce + per-session TTL) — a musterd analog needs consumed-markers and a
continuation cap the way Cursor has `loop_limit` and Grok has the 8-cap. Busy-race
warning: concurrent `promptAsync` against a running session has produced orphaned /
sibling assistant messages (#28202) — idle-triggered prompt is the safe shape; the
mid-turn abort-then-prompt ordering is untested here.

## 4. Idle-at-prompt: COVERED — the gap Cursor and Grok both have, OpenCode does not

No turn-end is needed: `prompt_async` targets the session, not the turn. Idle wake was
measured working (§1); transcript-only `noReply:true` lands for next-turn pickup even
if the loop never schedules. Two named omissions: (a) TUI rendering — #8564 reports the
TUI may not *render* `prompt_async` messages, so the model sees a doorbell the human
may not (matters for mixed human/agent seats); (b) the idle-wake race history —
#21524 (closed `not_planned`: intermittent 204-with-no-turn) and #32010 (open) describe
the same symptom class my one measurement did *not* hit, so treat reply-mode wake as
usually-works-not-guaranteed and keep `noReply` transcript land as the reliable floor.

## 5. Reachability precondition: the port-discovery gap

A TUI started bare gets a **random port**; `opencode serve` next to a running TUI
starts a **new, separate server** (docs) — sends to the wrong port land nowhere
visible. No documented discovery API (a community plugin exists just to *display* the
address: `expnn/opencode-server-info`). So: **musterd-spawned seats** can be doorbelled
iff the wake backend launches them with explicit `--port`/`--hostname` (or config
`server.port`) and records it — cheap, in our control. **Human-launched TUIs** are
unreachable until launched with an explicit port or `--mdns`. Auth (`OPENCODE_SERVER_
PASSWORD`) must be arranged the same way if set. This is the one scoping fact the
joint design must carry.

## Recommendation shape (eval only — no build in this lane)

1. Primary rail: server-mediated `prompt_async` against musterd-spawned seats on known
   ports. Default to transcript-only (`noReply:true`, daemon-composed doorbell, never
   the act body — ADR 167 rail discipline); reserve reply-mode for handoff-grade
   urgency (it spends model budget and inherits the wake race).
2. In-process complement (plugin: `session.idle` → inbox check → conditional prompt,
   code-review-plugin pattern) only after the port story is settled — it still needs a
   managed executable surface per ADR 362 finding 2, and the `experimental.*` hooks it
   would lean on for mid-turn reach are undocumented.
3. Do NOT build tool-boundary interrupt-check on `tool.execute.after` until the MCP-path
   mutation semantics are re-verified on 1.18.x — that is the exact path musterd's own
   traffic takes.
4. Cost note: the wake probe above ran a real ~11k-token turn against this machine's
   configured provider. Future evals use `noReply` or isolated keys.

## 7. Built (2026-09-06, ADR 392, lane `01M1T42J95QH6FB5BTKM3323JR`)

~~Nothing probes — no musterd plugin existed in any OpenCode worktree (2026-09-05 bell check)~~
BUILT 2026-09-06: `musterd init` / `musterd init --refresh-hooks` writes a marker-owned
`.opencode/plugins/musterd.js` (node built-ins only, no `package.json`, so no `bun install`):

- `tool.execute.after` → `musterd inbox --interrupt-check` in the seat folder → a raised line is
  appended to the tool `output` inside a `<musterd-interrupt>` fence (recommendation shape 2, the
  in-process complement — the plugin's `client` already knows the server, so the §5 port gap does
  not apply to it).
- `event: session.idle` → same probe → one reply-mode `client.session.promptAsync`
  (`synthetic: true`), capped at 4 per session.
- Doctor: `detect().hookDrift` names the plugin missing ("nothing probes the interrupt line") or
  STALE (ADR 168); surface `opencode:plugin` is refusable (ADR 332).

**Unmeasured on 1.18.29 (falsify each by running it — the eval owner is the OpenCode seat):**

- §2's MCP-path caveat: does the appended fence reach the model at an **MCP** tool boundary, or
  only at native ones? Falsify: one directed interrupt-class act mid-turn; an `interrupt.raised`
  row with no fence in the transcript at the next native boundary breaks the rail outright; a fence
  at native boundaries only confirms the caveat and narrows ADR 392 Decision 2.
- Whether `opencode run` (the wake child) delivers `session.idle` to the plugin before exiting on
  idle. Falsify: a raised line during a wake with zero `promptAsync` calls.
- Whether the TUI renders the synthetic idle prompt (#8564). Human-facing only.

## 8. Measured live 2026-09-14 on 1.18.29 (lane `01M1VHC3DZ`)

Setup: `opencode --version` 1.18.29, daemon c8e89dd (up to date), CLI
d1191493 (4 behind), adapter d2a0f0f (team_status warned stale before the MCP
channel dropped mid-session — see below), plugin marker v1 with no drift per
`init --check` (no refresh needed after the c8e89dd bounce).

- **Native boundary, raised line: CONFIRMED.** A real huddle turn (wanderer,
  doorbell-contract room `01M2GASFNZSZT0NV0HPV5EJFBA`) arrived fenced inside
  `<musterd-interrupt>` on a bash tool result mid-turn — answer (a) in the
  room's own protocol. Deaf-notice fences arrived after every other native
  call all session. The append-to-output path reaches model context at native
  boundaries, carrying raised lines and refusal notices alike.
- **MCP boundary: NO FENCE, confirming the §2 caveat live.** Zero fences
  across about 15 MCP (`team_*`) calls in the same window — not even the
  deaf-notice kind, while native calls fenced every time. Indistinguishable
  from inside whether the hook doesn't fire or the mutation lands where the
  model never reads; either way nothing model-visible arrives on the exact
  path musterd's own traffic takes. Endorses the room wording: name the seam,
  not "tool boundary".
- **Lease flap, with daemon-log evidence.** `reap_offline ghost`, then 33
  `interrupt_probe_refused` rows naming ghost / lease dead (ADR 391 working
  as designed), one unlogged success (the bell above), refused ever since.
  Re-occupy 09:17 PT rewrote binding.json with a fresh lease; dual
  `ws_close` 51s later; refused since. #1369 closed the bounce window — the
  reaper/reconnect path is the open hole (fodder for izzo's lease lanes, not
  this one).
- **MCP channel itself dropped mid-session** (`team_inbox_check` →
  "Not connected", tool surface gone); continued on the CLI fallback per the
  one-channel rule. A wake that never occupies says why — the session kept
  working because the plugin shells the CLI, not the adapter.
- **Idle bell: UNMEASURED.** No idle window occurred, and the lease was dead
  throughout. Standing warning for the next attempt: a refused probe still
  prints a non-empty line, so the first `session.idle` may ring a deaf
  notice rather than a turn — falsify by idling with a live lease and
  watching for one synthetic prompt + one turn (cap 4).
- **`opencode run` wake-child `session.idle` delivery: UNMEASURED.** No wake
  child in this eval. TUI render (#8564): human-only, unmeasured.


## 9. Clause-8 discovery half + idle-canary code paths, 2026-09-14 on 1.18.31 (lane `01M2GP0QM3`)

Setup: `opencode --version` 1.18.31, daemon 39343985, CLI 4bcea21 (8 behind,
`team_status` warned stale — read-only eval, no build run here), plugin marker
v1 with no drift per `init --check`, lease live (`musterd inbox
--interrupt-check` silent, exit 0 — nothing raised, nothing refused).

### 9a. Discovery: no deferral — granted IS callable (measured live)

OpenCode documents it and this session confirms it: "Once added, MCP tools
are automatically available to the LLM alongside built-in tools"
(`docs/mcp-servers`, fetched 2026-09-14). There is no `ToolSearch`
(Claude Code) or `GetDynamicTools` (Cursor) round-trip: the tools arrive in
context with their schemas, at the documented cost of context tokens (the
"MCP servers add to your context" caveat on the same page — the flip side of
Cursor's dynamic namespaces).

Live half: this seat's first acts of the session were direct `team_*` calls
(`team_inbox_check`, `lane_board`) with no preceding discovery call of any
kind. First-call success with no discovery step is clause 8's own falsifier
(contract §(8): "Falsify: a session whose first `mcp__musterd__*` call
succeeds with no preceding `ToolSearch`"), met here on the OpenCode naming
(`musterd_team_*`, no `mcp__` infix — same property). Verdict: **no deferral;
grant alone satisfies the callable half.** The woken-seat sharp case in
contract §(8) (actuator spawns with `--allowedTools mcp__musterd`, first
orientation call one `ToolSearch` away) does not transfer: an OpenCode wake
child carries the full tool table from its first step.

Falsify: an OpenCode session whose first MCP tool call fails until a
discovery/allowlist round-trip is spent (e.g. a permission-gated `tools.*`
glob defaulting closed — the per-agent `my-mcp*` pattern on the same docs
page is the place such a gate would live).

### 9b. Idle rail: silent path confirmed live, deaf path confirmed by code, raised path still unmeasured

Three probe outcomes, three plugin behaviours (`musterd.js`, `event` handler):

- **Silent (no interrupt, live lease): CONFIRMED LIVE.** The probe above
  returned `""`, exit 0. The handler's `if (!line) return` fires before any
  `promptAsync` — an idle with nothing waiting correctly rings nothing. No
  spurious turn, no budget spent. This is the common path and it is now
  measured, not assumed.
- **Deaf (stale lease): CONFIRMED BY CODE, not live.** `inbox.ts`
  `interruptCheck` emits the "interrupt line is deaf" line on a stale
  `session_lease`, and the plugin prompts it like a raised line (non-empty is
  non-empty — no status check between probe and `promptAsync`). So the first
  `session.idle` on a dead lease rings a deaf notice *as a synthetic turn*,
  spending a turn to say the bell is broken (2026-09-14, by code reading —
  falsify: idle with a dead lease and watch for zero prompts; silence would
  mean the probe path changed). This confirms §8's standing
  warning as the designed behaviour of the current text, and narrows the
  canary: idling with a live lease must produce zero prompts; idling with a
  dead lease is expected to produce one deaf-notice prompt (cap 4), which is
  the bug to fix, not the bell to trust.
- **Raised (interrupt waiting): UNMEASURED LIVE.** No idle window occurred
  and nothing was raised while idle. Both seams the handler leans on are
  documented, not experimental: `session.idle` and `tool.execute.after` are
  listed events/hooks on `opencode.ai/docs/plugins` (fetched 2026-09-14), so
  the version-coupling surface is two documented seams — but the wake half
  inherits the upstream race: #21524 (reply-mode `prompt_async` returns 204
  with no turn on idle sessions, intermittent) is the same symptom class §4
  already records. Falsify: idle with a raised line and watch for one
  synthetic prompt + one turn; a 204 with no turn reproduces #21524 through
  the musterd plugin and promotes the idle-delivery row to usually-works.

`session.idle` delivery to the plugin itself (does the event fire at all in
1.18.31) is unmeasured — no idle occurred. One community source marks
`session.idle` "deprecated but still emitted", against the official docs
  which list it without deprecation; if a future OpenCode stops emitting it
  (2026-09-14 reading of the current plugin text),
  the detector row fails silently (2026-09-14: the handler just never runs — no error, no
  log; falsify: idle with a raised line and watch the server log for the probe — a probe with no event
  means the event stopped, a 204 with no turn means the wake raced). The canary that covers both at once: idle with a raised line. Silence
after that means either the event stopped or the wake raced; either way the
rail is down.

Reconnect half (mid-session MCP drop revokes callability or not) is NOT this
lane — it is lane `01M2GS6Q4`, which depends on this one. Upstream
archeology held for that lane, not judged here: #17099 (a transient
`listTools()` failure permanently evicts the client — `delete
s.clients[clientName]`, no retry, no `onclose` handler) with fix PRs #17651
(retry + lazy re-creation) and #32084 (`onclose` removes the closed client
  and marks status failed), against open-as-of-2026-09-14 #38266 (serve: stdio
  connection reportedly dropped mid-session with tools unavailable until
  restart) and #25282 (no auto-reconnect or notification reported) — both
  upstream claims, neither re-measured here; falsify either on 1.18.31 with
  the live kill-and-call measurement on lane `01M2GS6Q4`. Whether 1.18.31 reconnects or stays mute is
  a live kill-and-call measurement, not a docs read.


## Related

- ADR 362 (plugin capture deferred; premise corrected) — the *outbound* half; this page
  is the *inbound* half and leans on none of its findings except the version-coupling
  warning, which §2 re-confirms independently.
- ADR 167 (harness-native session messaging) — the CCD rail this parallels; doorbell-
  not-payload discipline applies unchanged.
- Upstream: #21524, #32010 (idle-wake race), #28202 (busy-race siblings), #25918/#21149
  (after-hook shape), #25754 (in-place mutation), #8564 (TUI render), #5409 (resume
  fires no event — outbound, listed so the two halves are not confused).
