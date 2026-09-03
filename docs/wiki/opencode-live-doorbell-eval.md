# OpenCode live-doorbell eval

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

## Related

- ADR 362 (plugin capture deferred; premise corrected) — the *outbound* half; this page
  is the *inbound* half and leans on none of its findings except the version-coupling
  warning, which §2 re-confirms independently.
- ADR 167 (harness-native session messaging) — the CCD rail this parallels; doorbell-
  not-payload discipline applies unchanged.
- Upstream: #21524, #32010 (idle-wake race), #28202 (busy-race siblings), #25918/#21149
  (after-hook shape), #25754 (in-place mutation), #8564 (TUI render), #5409 (resume
  fires no event — outbound, listed so the two halves are not confused).
