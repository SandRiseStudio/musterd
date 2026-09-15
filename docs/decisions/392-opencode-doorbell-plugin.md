# 392 — The OpenCode doorbell is a managed plugin

- Status: proposed
- Date: 2026-09-06
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt line: a silent-or-one-line probe at every tool boundary), [ADR 370](370-grok-interrupt-injection.md) (the idle-at-turn-end rung and its per-session cap), [ADR 362](362-opencode-hook-channel-capture.md) (OpenCode's plugin channel exists; a *capture* plugin is deferred on three findings), [ADR 321](321-opencode-first-class-harness.md) (OpenCode as a first-class harness; §3's plain-JSON posture, §8's heartbeat capture), [ADR 168](168-hook-content-drift.md) (the doctor compares installed text against what this build writes), [ADR 027](027-non-invasive-harness-coexistence.md) (guest posture), [ADR 332](332-declined-surface-tombstone.md) (a surface can be declined by name)
- Lane: 01M1T42J95QH6FB5BTKM3323JR (izzo; opened from the 2026-09-05 bell check)

## Context

Ghost's live-doorbell eval ([opencode-live-doorbell-eval.md](../wiki/opencode-live-doorbell-eval.md),
2026-09-03, opencode 1.18.27) measured every rail by which a bell could reach a running OpenCode
model: `tool.execute.after` mutates tool output in place; `session.idle` plus an in-process
`client.session.prompt` is a shipped turn-continuation pattern; `prompt_async` lands transcript-only
or reply-mode. It was an eval, not a build. Nothing was installed. The 2026-09-05 bell check found
the consequence: the OpenCode seat (ghost) had the musterd MCP tools and **no probe at all** —
`musterd inbox --interrupt-check` never ran in that harness, at any boundary, so the seat could not
hear a bell it was fully entitled to. Every other harness runs the probe from a hook file
(Claude Code `.claude/settings.local.json`, Cursor `.cursor/hooks.json`, Grok `.grok/hooks/musterd.json`,
Codex `.codex/hooks.json`). OpenCode has no hook table (ADR 321 §8); its equivalent seam is a plugin.

ADR 362 declined to ship a plugin — for **capture**. Its three findings were: (1) resume fires no
bus event, so a capture plugin is blind on wake's primary path; (2) a plugin is executable code
installed into the harness process, a step past ADR 027's guest posture; (3) the plugin API moves
between releases. Those findings are the reason this ADR exists as a separate decision rather than a
quiet reversal: the doorbell is a different job, and each finding has to be met on its own terms.

## Decision

1. **`musterd init` writes one plugin file, `.opencode/plugins/musterd.js`, and it is the OpenCode
   interrupt line.** Marker-owned (`// musterd-opencode-interrupt v<N>` header), rewritten only by
   `musterd init --refresh-hooks`, removed by `unprovision` of the musterd server, gitignored
   beside `.opencode/opencode.json`. The harness's `refreshHooks` slot owns it; `detect` reports its
   drift as `hookDrift`; the refusable surface name is `opencode:plugin`.
2. **Two documented hooks, nothing experimental.** `tool.execute.after` runs
   `musterd inbox --interrupt-check` in the seat folder and, if a line comes back, appends it to the
   tool's `output` inside a `<musterd-interrupt>` fence — the text the model reads next.
   `event: session.idle` runs the same probe and delivers a raised line as one reply-mode
   `client.session.promptAsync` (`synthetic: true`), capped at 4 per session so an ignored bell
   cannot spend budget forever. The `experimental.chat.*` transforms are not used: they are
   undocumented and would re-create the coupling ADR 362 finding 3 names.
3. **The plugin composes nothing.** The line is the daemon's (ADR 088); the CLI keeps every gate it
   already has (explicit bound seat, `MUSTERD_NO_NUDGE=1`, silence on any failure, no cursor
   advance). The plugin adds a 5-second timeout and swallows every error — a probe on every tool
   call must never disrupt the loop.
4. **ADR 362's findings, met not waived.** (1) Resume: the doorbell does not need a session-start
   event — tool boundaries and idle both fire on a resumed session, so the objection that sinks a
   capture plugin does not touch this one. (2) Executable surface: the file imports only
   `node:child_process`, carries no `package.json`, so OpenCode runs no `bun install`; it is one
   marker-owned file with a generation stamp, the same managed-surface contract every hook file
   already has, and the ADR 168 downgrade guard refuses to overwrite a newer generation or a
   foreign file at the path. (3) Version coupling: bounded to two hooks that are documented and
   typed in `@opencode-ai/plugin`; the generation stamp is the pin, and a stale plugin is named by
   the doctor as STALE rather than silently rotting.
5. **ADR 362 stands for capture.** Nothing here reopens capture-via-plugin; heartbeat-side
   reconciliation remains the capture primary and ADR 362 Decision 3's falsifiers remain the only
   thing that reopens it. An amendment note on ADR 362 points here.

## Consequences

- OpenCode joins the `refreshHooks` implementers (Claude Code, Cursor, Grok, Codex). The
  `init --refresh-hooks` driver's hedge about "the only implementer" was already stale before this.
- The server-mediated rail (eval §1, `prompt_async` from outside the process) is **not** built here.
  The in-process plugin sidesteps the port-discovery gap the eval named as the scoping fact — the
  plugin's `client` is already bound to the right server — so the daemon-side rail is a separate
  decision if a reason for it appears (a human-launched TUI with no plugin is the case it would
  cover, and that seat has no probe today either way).
- Wake children (`opencode run --format json`) load project plugins at startup like the TUI does,
  so a musterd-spawned seat carries the probe from its first tool call. Whether the idle bell fires
  before `run` exits on idle is unmeasured (see Falsifiers).
- The MCP-tool-path caveat (eval §2) is carried, not resolved: musterd's own tool calls are MCP
  calls, and whether a `tool.execute.after` mutation reaches the model on that path in 1.18.29 is
  the first thing to measure. If it does not, the idle rail is the floor and the tool-boundary rail
  reaches the model on native tool calls only (reads, edits, shell) — which is still every boundary
  a working agent crosses between MCP calls.

## Observability & Evaluation

- **Traces:** none new. The daemon already audits `interrupt.raised` per probe (ADR 088) and
  `interrupt.refused` per refused one (ADR 391); an OpenCode seat's rows are the evidence its probe
  runs. The doctor line for a missing plugin reads "nothing probes the interrupt line".
- **Eval (owner: ghost, the OpenCode seat):** after `musterd init --refresh-hooks` in ghost's
  workspace, one directed interrupt-class act while ghost is mid-turn. Expected: an
  `interrupt.raised` row for ghost, and the `<musterd-interrupt>` fence visible in ghost's
  transcript at the next tool boundary. Then the same act while ghost is idle: one synthetic user
  message and a turn. Record both on the eval page (§7 there).
- **Experiment:** n/a — this is the build the eval asked for; the measurements above are its test.

## Falsifiers

- `musterd init --refresh-hooks` in an OpenCode-provisioned folder, then `musterd init --check`:
  if the plugin is present and current, no OpenCode hook drift is reported; edit one byte of the
  file and the doctor names it STALE. If either reads otherwise, ADR 168 is not applied here.
- Ghost's mid-turn measurement above: a raised `interrupt.raised` row with no fence in the
  transcript at the next **native** tool boundary falsifies Decision 2's tool-boundary rail.
- The same at an **MCP** tool boundary only, with native boundaries carrying the fence, confirms
  eval §2's caveat on 1.18.29 and is recorded on the eval page — it narrows Decision 2, not this ADR.
- Five idle bells for one session with the act left unread: more than four `promptAsync` calls means
  the cap is off. Zero calls with a raised line in the same window means the `session.idle` event
  is not reaching the plugin in that runner (the `run` exit-on-idle question).
- `bun install` observed at OpenCode startup in a musterd-provisioned folder with no user
  `package.json` present: the plugin grew a dependency and Decision 4(2) is broken.
