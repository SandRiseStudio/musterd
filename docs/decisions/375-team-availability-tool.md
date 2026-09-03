# 375 — `team_availability`: an agent can set its own availability from MCP

- Status: accepted — 2026-09-03 (nick approved the surface survey's ranked recommendation, item 6)
- Date: 2026-09-03
- Builds on: [ADR 044](044-notification-tiers-localhost.md) (the availability axis), [ADR 148](148-feature-epoch-roster-skew.md) (feature epoch), the surface survey (`docs/wiki/command-and-tool-surface-map.md`, #1245)
- Lane: `01M1MP56KDTQM03WH05RAXZYHJ`
- Snapshot-debt: none — the tool's contract is the existing `POST /teams/:slug/availability` route; nothing new is stored.

## Context

ADR 044 gave every member an availability axis — `available`, `away [--until]`, `dnd` — explicit and self-only, read by the notify loop to tier deliveries. The CLI had `musterd availability` from the start. The MCP surface never got a twin: an agent that wanted to say it was away for an hour had to shell out to the CLI, or stay "available" while absent. The surface survey (2026-09-03) graded this the one genuine parity gap between the two surfaces.

## Decision

1. **`team_availability {status: 'available'|'away'|'dnd', until?: ISO}`** joins the MCP tool list as the twin of `musterd availability`. Same route, same rules: `until` rides `away` only and is validated before any call; the result names the member and points at `team_status`.
2. **Not a `WRITE_TOOL`.** Like `team_join` / `team_leave`, availability is the seat's own state, not messaging: a muted seat (`can_message: 'none'`) must still be able to say it is away.
3. **`FEATURE_EPOCH` 18 → 19.** A tool an older seat's list does not carry is a client-visible capability by ADR 148's rule; the roster's `behind` hint is the only consequence.
4. **Budget.** The tools/list render grows 747 B; both context budgets (`docs/perf/context-budgets.json`) still hold — default headroom 964 B, muted headroom 78 B. The muted budget is now the tighter of the two and the next tool added will have to pay for it.

## Consequences

- Parity on the one axis the survey found missing; `docs/architecture/05-mcp.md` counts twenty-nine tools.
- The muted budget's 78 B headroom is a real constraint on the next addition, deliberately not raised here: a budget raise needs its own justification (spec 2026-08-03), and this tool's rent is the parity it closes.

## Observability & Evaluation

- **Traces:** every call lands as a `member.availability` audit row (the existing route), now with an MCP surface (`claude-code`, `codex`, …) instead of `cli`; the roster renders the result as `away`/`off until <t>`/`dnd`.
- **Eval:** within one FEATURE_EPOCH, at least one `member.availability` audit row whose surface is an MCP harness. Falsifier: every availability change in the audit log still arrives via `cli` — then agents did not need the tool and it should be folded back. Second falsifier (rule 2): a muted seat calling `team_availability` is refused — then the tool is wrongly scoped.
- **Experiment:** n/a — a parity tool; the only comparison worth running is the eval above.
