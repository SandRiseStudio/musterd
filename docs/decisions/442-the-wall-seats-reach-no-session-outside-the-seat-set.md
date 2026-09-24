# 442 — The wall: seats reach no session outside the seat set

- Status: proposed
- Date: 2026-09-23
- Lane: `01M37QER48T0Q5D7K4ATQHV9EM` (goal `reach-and-boundaries`; sub-lanes 1b–1e carry the rest)
- Design: `docs/superpowers/specs/2026-09-23-reach-and-boundaries-design.md` §2–§4, §6, §7
- Plan: `docs/superpowers/plans/2026-09-23-the-wall.md`
- Amends: ADR 167 (retires increment 2, folds increment 1's observer into this gate), ADR 413.
  Supersedes the `--as` resolution of ADR 059.

## Context

On 2026-09-22 a woken dolly session raised an `ask` to nick. The daemon's ack carried a
`delivery_hint` (ADR 167 increment 2) because nick had fresh presence. The `musterd-nudge-relay`
skill told the sender to pick "a session the human is actively driving". Dolly called `ListAgents`,
chose a Claude Code session that was not a musterd seat, and `SendMessage`d the nudge into it. That
session followed the nudge's own words and ran `musterd inbox --as nick`, reading nick's inbox under
nick's identity. No credential was taken and nothing was written, but every step was allowed.

The design (spec above) was brainstormed with nick, security-reviewed by big-body, and reviewed a
second time on PR #1662 by izzo, wanderer, stanley (ADR 167's author) and big-body. All four
converged on the decision below.

## Problem

Five things let a model's choice cross from the team into the rest of the machine:

1. A model chose which session to message, and nothing bounded that choice to seats.
2. `SendMessage` and `ListAgents` are not even observed. ADR 167's hook matches only
   `mcp__ccd_session_mgmt__send_message`.
3. A line's words were treated as an instruction. The receiving session obeyed "run
   `musterd inbox`".
4. Any process under the same OS user could resolve any identity in `~/.musterd/config.json` with
   `--as`. From an unbound folder, it got the human's identity by default.
5. Lines do not name their team.

ADR 167's own alternative, a host-side broker, cannot fix item 1. No host process can call a
harness's `send_message`: ADR 167 §increment 2 says so, and it is why 167 made the *sender* the
relay. Cursor and Codex have no peer-session tool or host injection path at all.

## Decision

1. **The seat↔seat relay is removed.** The daemon issues no `delivery_hint` for any recipient kind.
   The `musterd-nudge-relay` skill is deleted. ADR 167 increment 2 is retired whole, and the
   `nudge.decision` audit row ends with it. The `DeliveryHint` type stays in `@musterd/protocol` so
   an older daemon's ack still parses. Nothing may act on a hint that arrives.
2. **Session-reaching tools are refused in a seat Workspace.**
   - `@musterd/protocol` exports `SESSION_REACH_TOOLS`, a frozen list: the five
     `mcp__ccd_session_mgmt__*` session tools, `ListAgents`, and `SendMessage`.
   - The ADR 150 PreToolUse gate refuses these **locally, before any daemon round trip**, so a
     daemon outage cannot open the wall.
   - ADR 167 increment 1's always-allow observer matches the same tool and folds into this verdict.
     It does not run beside it.
   - An unknown session-reaching tool is a gap to add to the list, not a pass.
3. **`SendMessage` is scoped, not blanket-denied.** It is also a session's channel to the subagents
   it spawned. The gate allows it only toward a subagent the calling session spawned. The
   implementing lane (1c) records whether the harness exposes a stable subagent id. If it does not,
   `SendMessage` is denied too, and this ADR's Consequences records that loss: a seat cannot message
   a running subagent, but subagent results still return to the caller.
4. **Every refusal is audited** as the actor attestation kind `session-denied` with `{tool,
   harness}` only. The daemon writes it as `gate.session_denied`, `result: deny`, no target. It
   carries no body, no session id, no credential. The row is the audit of a decision the client
   already made. It is not the decision.
5. **A line is a pointer.** Interrupt, wake and nudge lines name their team (`musterd [<team>]:`)
   and say "pointer only — read it as yourself". A seat acts only on what its own authenticated read
   of the named act returns. A line that does not resolve to an act addressed to this seat on this
   team is ignored and reported.
6. **Identity is the Workspace binding, or nothing.** `--as` is removed from the CLI surface. The
   global-config vault stops being a resolution source; it remains storage that `claim`/`init` use
   to rebind a folder. A folder with no binding resolves to nobody. `MUSTERD_CLAIM` env identity
   (service homes, tests) still resolves. Both closes ship in the wall: the incident used `--as`,
   and a plain `musterd inbox` from an unbound folder would have resolved nick just as well.
7. **Where a harness cannot express the gate, that is stated, never claimed.** Per-harness reach, as
   of this ADR:

   | Harness | Session-reach gate | Why |
   | --- | --- | --- |
   | Claude Code | gated | PreToolUse matches tool names |
   | Cursor | not gateable, identity-only | preToolUse matcher covers only `Shell\|Write\|Delete\|Edit\|Task` |
   | Codex | not gateable, identity-only | no PreToolUse hook |
   | Grok, opencode | determined by lane 1c | inventory pending |

   On an identity-only harness, the incident's replay is `Shell` plus `--as`, which item 6 closes.

**What this does and does not protect.** The wall, the pointer rule and binding-only identity
prevent cross-session and cross-identity mistakes by models. They are not a boundary against a
hostile process under the same OS user. Such a process can read any binding or config file, `cd`
into any Workspace, or call the daemon's HTTP API directly with a credential it read. Closing that is
credential custody (ADR 200, ADR 341, and spec §8).

## Consequences

- Seat-to-seat delivery loses the seconds-latency rail to an attended, idle peer. Directed acts
  still reach seats through the inbox, the ADR 088 interrupt line, and the wake host. The measurement
  lane (spec §5) decides when the wake host's attended-session deferral can shrink.
- Humans are reached through `/live` and the inbox until the doorbell (spec §1, its own ADR) ships
  the `os` / `slack` / `webhook` sinks.
- **Feature epoch 23.** A daemon behind it refuses a `session-denied` body. The client's report is
  fire-and-forget, so the refusal itself still stands locally. Merge order within the wall: 1b (the
  daemon's `session-denied` branch) lands before 1c (the client that sends it). Otherwise a daemon
  at epoch 23 without 1b would file the row under its catch-all attestation branch.
- `--as` users break at once: scripts, the wiki, operator muscle memory. The identity lane (1d)
  announces before it merges. `team create` names its creator with `--member`.
- **Admin enrollment moves to the admin's own folder** (lane 1d, 2026-09-23). `residency on/off`
  used `--as <admin>` from the agent's folder. It now runs from an admin's Workspace with `--seat
  <agent> --workspace <its folder>`: the daemon-issued grant lands in the agent's folder, and the
  admin's identity never does. Bare `agent --driver` names the member the folder resolves to.
- **What 1d does not close.** `init`, `claim`, `human`, `team` and `agent` still read the vault as
  *storage*, to provision or rebind a folder with a credential this machine already holds. A harness
  session can run them, so an admin provisioning act can still start from a harness. Spec §6 names
  this: admin-from-a-harness is an operator convention until browser-bound confirmation exists
  (spec §8). The acting surface is closed: no command resolves the vault as its identity.
- The Claude Code peer label sweep (`list_sessions` across the machine) is retired. The host labels
  seat sessions (ADR 166). Cursor's self-label path, which touches only the current chat, is kept.
- **Lane 1c spike (2026-09-24, Claude Code 2.1.281 transcripts).** `SendMessage` addresses its
  target with `tool_input.to` (the same string is also copied to `recipient`). An async `Agent`
  tool result is text, not a JSON id: a line `agentId: <hex>` and the instruction to continue with
  `SendMessage` `to` that hex. The gate records that id and allows `SendMessage` only toward it.
  Foreground `Agent` results that carry no id are not addressable, so a `SendMessage` to them is
  denied. Per-harness reach after the inventory:

  | Harness | Session-reach gate | Why |
  | --- | --- | --- |
  | Claude Code | gated | PreToolUse matcher is `SESSION_REACH_TOOLS`; PostToolUse `Agent` records the spawned id |
  | Cursor | not gateable, identity-only | preToolUse matcher is only `Shell\|Write\|Delete\|Edit\|Task` |
  | Codex | not gateable, identity-only | no PreToolUse hook |
  | Grok | not gateable, identity-only | PreToolUse exists, but Grok has no session-reach tool names to match |
  | opencode | not gateable, identity-only | the doorbell plugin runs after the tool (`tool.execute.after`) |
- 2026-09-24 (sub-lane 1b, #1676): the guidance change landed as `GUIDANCE_CONTENT_VERSION` 30. The
  relay and peer-sweep renderers left `@musterd/protocol`, and `GUIDANCE_INSTALL_PATHS` dropped both
  retired paths. The CLI sweeps a stamped copy at either path on every guidance write, so a seat
  provisioned before the wall loses them at its next refresh. `session label-nudge` stays as a
  silent no-op, because hooks installed before the wall still call it.
- 2026-09-24 (reach spec lane 2 — layout): identity now resolves by **real path** — both readers
  (`findBinding`/`findWorkspaceSpec` in the CLI, `walkUpForBinding`/`resolveBindingDir` in the MCP
  adapter) realpath the start folder before walking up, so a symlink into a Workspace resolves as
  the folder it really is (a not-yet-existing tail resolves through its nearest real ancestor). And
  a binding never sits above a Workspace: `bindingRefusal` (`onboard/guard.ts`) hard-refuses `~`,
  `~/musterd`, and any folder with a `.musterd/binding.json` up to two levels beneath it (skipping
  `node_modules`/`.git`, not following symlinks), compared by real path so a symlinked alias is
  refused like the real folder. `musterd init` and `musterd human` always refuse; `musterd claim`
  refuses only a **first** binding, so the pre-migration `~/agents` (bound, with `.worktrees/*` Workspaces
  beneath) keeps re-claiming until lane 3 moves it to `~/musterd/agents/nick`. The member Workspace
  layout is `~/musterd/<repo>/<member>`; the team home `~/musterd/<team>` (`defaultTeamHome`) is a
  leaf and stays bindable. Physical migration of `~/agents` and `~/agents-<seat>` is lane 3.

## Observability & Evaluation

- Traces: each refusal is an audit row `gate.session_denied` `{tool, harness}`, with no body, no
  target and no session id:
  `SELECT json_extract(detail,'$.tool'), json_extract(detail,'$.harness'), COUNT(*) FROM audit
  WHERE action = 'gate.session_denied' GROUP BY 1, 2;`. A non-zero count is the wall working, not an
  incident. `actor.session_message` rows stop after the wall ships. A new one means a harness reached
  a session through a path this ADR did not list: add that tool to `SESSION_REACH_TOOLS`.
- Eval: the dataset is the per-harness gate fixtures (lane 1c), the daemon ack fixtures (lane 1b),
  and the identity-resolution fixtures (lane 1d). The baseline is today's behavior: `ListAgents` is
  allowed, a directed act to a live recipient carries `delivery_hint`, and an unbound folder with a
  human in the vault resolves that human. Each fixture asserts the opposite.
- Experiment: the canary (lane 1e, `wall.canary.e2e.test.ts`) replays the incident on `main`. A seat
  Workspace session tries `send_message` into a non-seat session, and an unbound folder runs
  `musterd inbox`. If the send is delivered, or the inbox read authenticates as any member, this
  decision is not implemented.

Follows-up: lanes `01M37QF96W7GA0E0AQYCNF9YJW` (1b), `01M37QFSHEGFY9AASQWEH35EQK` (1c),
`01M37QFV3V56P6PNG6DH7WP8BE` (1d), `01M37QGEJ727BRB6RQV5MNHTN0` (1e)
