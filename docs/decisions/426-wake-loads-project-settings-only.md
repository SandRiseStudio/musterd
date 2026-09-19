# 426 — A wake spawn loads project and local settings, not the human's user layer

- Status: proposed
- Date: 2026-09-19

## Context

A residency wake (ADR 131) spawns `claude -p` in the seat's Workspace with the composed line, a pre-minted session id, `--allowedTools mcp__musterd`, and `--output-format json` (`argTail`, `packages/cli/src/host/backends/claudeCode.ts`). Nothing in that argv says which settings layers the harness should load, so the run loads the same three the human's interactive sessions do: user (`~/.claude/settings.json`), project (`.claude/settings.json`) and local (`.claude/settings.local.json`).

The user layer is where the human keeps *their* harness: on this machine, twenty enabled plugins with their skills, hooks and MCP servers, an output style, and personal permission grants. The project and local layers are where musterd provisions the seat: `musterd init` writes the seat's hooks (SessionStart capture, PostToolUse interrupt line, PreToolUse lane gate) and the permission floor (ADR 261, `mcp__musterd` included since #1371) into `.claude/settings.local.json`. The musterd MCP server itself is registered in `~/.claude.json` under the repo root (ADR 165, `mcpEntry.ts`), which is not a settings layer at all.

## Problem

Lane 01M2SB89AR measured a wake life at 529–1583 KiB against the 256 KiB `transcript_max_bytes` hygiene bound ([wiki](../wiki/resume-bound-is-below-one-wake-life.md)). This lane measured where that goes. Across twelve single-life wake transcripts (2026-09-19), the user layer accounts for 195–362 KiB per life: the skill listing (68 KiB, ~500 plugin skills), the deferred-tools list (47 KiB), MCP instruction blocks (33 KiB, twenty servers), the output-style reminder re-attached every turn (35 KiB), and ~140 plugin hook records per life (110 KiB — `hookify`, `security-guidance` and `cognee` each run on every Bash call and write a 687-byte record even when they print nothing).

A controlled A/B in this Workspace, one prompt, no tool call (2026-09-19):

| spawn                                | transcript | context created | cost   |
| ------------------------------------ | ---------- | --------------- | ------ |
| default (user + project + local)     | 383 KiB    | 58,727 tokens   | $1.52  |
| `--setting-sources project,local`    | 182 KiB    | 22,487 tokens   | $0.23  |

So an *empty* wake life under today's argv is already 1.5× the hygiene bound, and its fixed boot cost — before any work — is the "$0.91–1.51 fresh" the 2026-07-29 calibration measured. Six and a half times that cost is the human's plugin catalogue, loaded into a headless process that never gets to use it. In the trimmed run the musterd MCP server, the Workspace's own 21 skills, and the project-local hooks were all present; the musterd SessionEnd hook fired.

## Decision

1. **`argTail` passes `--setting-sources project,local` on every wake spawn**, fresh and resume alike (one posture per run, as with the permission flags). A woken session loads what musterd provisioned for the seat and what the repo commits, never the human's user layer.
2. **The user layer's musterd nudges are not missed.** The two machine-level hooks (`claude-code:machine:UserPromptSubmit` / `SessionStart`) print the orientation and status nudges for *interactive* sessions; a wake already carries its orientation in the composed line and its capture in the local SessionStart hook. Nothing a wake needs lives only in the user layer — the A/B is the evidence, and the invariant test pins the flag.
3. **Plugins are opted out of wakes, not out of seats.** A human working the seat interactively still has every plugin. A woken seat has the repo's committed skills (`.agents/skills`, `.claude/skills`) and the tools its Workspace allows. If a team wants a plugin in wakes, it belongs in the project layer, where every seat gets it and the cost is visible in the repo.
4. **No policy knob.** The flag is unconditional. A per-team `setting_sources` field would be a protocol change for a choice nobody has yet asked to make differently; the ADR records the trade-off and a later ADR can add the knob against a measured need.

## Consequences

- Empty-life transcript 383 → 182 KiB, under the 256 KiB bound; boot cost $1.52 → $0.23 per wake on this machine. The bound now admits a life again; whether a *working* life stays under it is the lane's acceptance measurement, recorded on the wiki page.
- The cost floor of every wake on a machine with a rich user layer drops by whatever that layer costs — here 36k tokens of context per turn, on every turn of every wake.
- Woken sessions lose user-level plugins: on this machine that includes `superpowers` (brainstorming, TDD, systematic-debugging) and `cognee-memory`. Interactive sessions in the same Workspace keep them. If a team decides wakes should carry a craft skill, the repo's committed skills are the place.
- Woken sessions lose user-level permission grants. The project-local floor (85 entries here, `mcp__musterd` among them) governs, which is what ADR 261 always intended for a seat.
- The claude.ai connector servers (account-level, eleven here) survive the flag; they are not a settings layer. Dropping them needs `--strict-mcp-config` with an `--mcp-config` file that carries musterd's entry, a further increment for this lane if the residual measurement says they matter.
- Codex and OpenCode backends are unchanged; their argv has no equivalent and their lives were not measured here.

## Observability & Evaluation

- **Traces:** the spawn argv is already logged by the host (`host.log`, `spawn:` lines); `--setting-sources` appears on every wake once this lands. `residency.wake_cost` rows carry the per-wake cost the A/B compared.
- **Eval:** the lane's acceptance — single wake lives, re-measured per line type on at least two seats after this lands, recorded on the wiki page beside the 2026-09-19 numbers. Falsifier: a wake life on a seat whose Workspace commits no extra skills that still carries a `skill_listing` attachment over 20 KiB, or a `hook_success` record whose `command` contains `CLAUDE_PLUGIN_ROOT`, means the flag did not reach the spawn.
- **Experiment:** the ADR 131 resume path is the beneficiary. Once lives sit under the bound, `residency.woke` rows with `session: resumed` should reappear on wakes that are not ADR 209 portable — the first such row since 2026-09-14 is the end-to-end check, and ADR 424's badge re-arming on it is the roster's.
