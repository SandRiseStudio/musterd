# 081 — The seat lives in binding.json, not the MCP env: stop baking `MUSTERD_CLAIM`

- Status: accepted
- Date: 2026-07-01

## Context

A folder's agent identity is resolved through **two channels that must agree**: the `musterd` CLI reads
`.musterd/binding.json`, and the MCP adapter (the `team_*` tools) reads its own config. ADR 018 declared
`binding.json` the single source of truth, and `05-mcp.md` documents the adapter's per-field resolution
ladder as **`env > binding.json > workspace.json`** (`packages/mcp/src/config.ts`).

But provisioning contradicted that. `musterd init`/`agent`/`wire` **baked** the seat into the MCP
registration as a static `-e MUSTERD_CLAIM=seat:<name>` (`buildMcpEnv`, `packages/cli/src/onboard/mcpEntry.ts`).
Because env **outranks** binding.json in the ladder, that frozen copy shadowed the file. The seat is the
one field that legitimately **changes after provisioning** — `musterd claim <name>` (ADR 055/077) rewrites
`binding.json`'s `claim` but never touches the harness's baked env. Result: after a re-claim the CLI
resolved the **new** seat while the MCP `team_*` tools stayed pinned to the **old** one — a silent
identity split. Observed live 2026-07-01: one folder resolved `Miley` on the CLI and a stale `Sonnet`
(unclaimed pending presence) on the MCP channel, the latter piling up approval requests it could never
consume. `init --check` (ADR 060) didn't catch it — it only checked **presence** (primer vs.
server-registered), never **value**.

## Decision

**Keep the seat in `binding.json`; never materialize it into the MCP env by default.**

- **`buildMcpEnv` no longer emits `MUSTERD_CLAIM`.** The adapter derives the seat from `binding.json`
  (or the committed `workspace.json`, ADR 080) on **every** launch, so a re-claim is followed
  automatically — there is no frozen copy to drift. `MUSTERD_AGENT_KEY` and `MUSTERD_GRANT` are still
  written (a grant is a stable secret that doesn't change on re-claim, and a standing grant is what lets
  autojoin occupy without an approval request — ADR 077).
- **`MUSTERD_CLAIM` survives as a supported _manual override_.** The ladder still honors it when set — for
  a headless/CI folder that has an agent key but no `binding.json`, env is the only way to name the seat.
  It simply isn't written by `init`/`agent`/`wire`. The `musterd agent` copy-paste fallback (shown when
  `claude` isn't on PATH) is rebuilt from `entry.env`, so the manual command matches auto-register exactly
  and can't reintroduce the drift.
- **`init --check` gains value-coherence.** `claudeCode.detect()` reads back any legacy baked
  `MUSTERD_CLAIM` via `claude mcp get`, and `inspectProvisioning` (`onboard/doctor.ts`) flags a third kind
  of drift — a baked claim that disagrees with `binding.json`'s `claim` — so a folder still carrying an old
  registration self-diagnoses, pointing at a re-run of `init`.

## Consequences

- The ADR 018 guarantee — CLI and adapter resolve the **same** seat in a given folder — now holds under a
  re-claim, not just at first provisioning. "Never bake the mutable field" is the general rule; only the
  stable secrets (`agent_key`, `grant`) are baked.
- Existing folders provisioned before this change still carry the baked `MUSTERD_CLAIM`. They keep working
  (env == binding until a re-claim), and `init --check` now surfaces the mismatch if one appears; a
  re-run of `musterd init` re-writes the registration without the claim.
- Docs reconciled: `05-mcp.md` (env block + resolution ladder), `04-cli.md` (`doctor.ts` line),
  `agent-primer.md` (the name-collision guard now scans `binding.json`'s `claim`, not the server env),
  `SPEC.md` A.9 + the roadmap P3 entry (the surface-migration env list), and superseded notes on ADR 060
  and ADR 075. Landed as PR #58 (`19ccdb0`), 369 CLI tests green.

## Observability & Evaluation

n/a — a purely mechanical provisioning/config-plumbing change: which env vars `buildMcpEnv` writes, and a
read-only value comparison inside `init --check`. It emits no coordination acts, opens no team-task spans,
and changes no agent-facing behavior beyond removing an identity-drift failure mode — so there is nothing
new to trace, score, or run an experiment on. The drift it prevents was itself found by dogfooding, not by
a metric.
