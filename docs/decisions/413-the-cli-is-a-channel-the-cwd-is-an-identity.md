# 413 — The CLI is a channel; the working directory is an identity

- Status: accepted
- Date: 2026-09-17
- Relates to: [ADR 012](012-agent-primer.md) (the primer is the standing context a seat carries),
  [ADR 075](075-p3.3-cli-claim-surface-migration.md) (`MUSTERD_MEMBER` retired for `MUSTERD_CLAIM`),
  [ADR 085](085-layered-guidance-surface.md) (primer is the loop kernel; content version bumps on
  change), [ADR 326](326-session-orientation.md) (the orient skill, which ends on a CLI write)
- Lane: `01M2RP18EVRCY0CHW8G12GTWKH`

## Context

Since the first cut the primer has carried a channel rule. Its current form:

> Use one channel only: with the `team_*` tools, do not also drive the CLI (it resolves to a
> different identity and your sends fail).

It replaced an outright ban on the CLI, which had misled agents in workspaces with no MCP server
(recorded in `docs/design/agent-primer.md`). The caution that replaced the ban kept the ban's
premise: that reaching for the CLI beside the tools is what produces a second identity.

That premise had a real cause once. A registration could bake `MUSTERD_MEMBER` and disagree with
`.musterd/binding.json`. ADR 075 replaced that surface with `MUSTERD_CLAIM`, and as of 2026-09-17
nothing under `packages/` reads `MUSTERD_MEMBER` at all (falsify: `grep -rn MUSTERD_MEMBER
packages` — a hit outside `dist/` disproves this). <!-- claim: other -->

The last live instance on this machine was `/Users/nick/SandRise`: its MCP entry said `Clyde`
while its `binding.json` said `Cosmo`, with two different `mskd_` tokens. That workspace was
pre-ADR-281, its adapter had been failing `CONNECTION_CLOSED` rather than attaching a wrong
identity, and it was pruned the same day.

## Problem

Two faults, independent of each other.

**The rule names the wrong cause.** Both channels resolve a seat from the same
`.musterd/binding.json`, so in a seat's own Workspace they agree by construction. What decides the
seat is the working directory. Measured 2026-09-17 against daemon build `76b4b16`:

| cwd | `musterd whoami` |
| --- | --- |
| `/Users/nick/agents-stanley` | `stanley on revive (cli · binding)` |
| `/Users/nick/agents-miley` | `miley on revive (cli · binding)` |
| `~` (unbound) | `nick on revive (cli · config)  (read-only)` |

So the rule forbade a safe thing and stayed silent about a dangerous one: run the CLI from a
teammate's Workspace and you act as them.

**The rule forbids what we prescribe.** `renderOrientSkill` — in the same file as the rule —
ends orientation on `musterd session orient-stamp`, a CLI write. The MCP surface is `lane_*` and
`team_*` only: there is no `session_*` and no `stream_*`. Every seat that followed the orient
skill broke the primer's rule.

A rule every compliant seat must break does not fail loudly; it fails as self-doubt. Measured
2026-09-17: asked why it was not using the MCP tools, a seat listed three CLI calls, correctly
excused two as having no MCP equivalent, and convicted itself of the third — *"the CLI resolves
to a different identity than the seat I joined through MCP."* It had done nothing wrong. The same
session had switched to the CLI because `lane_board {mine}` overflowed the tool-result limit
(lane 01M2R988GK), so an unusable verb did not merely fail: it pushed a seat off the channel and
then the guidance told it that leaving was the error.

## Decision

1. **The channel is a preference, not an exclusion.** Prefer the `team_*` tools where the session
   has them. The `musterd` CLI is the right route where no tool exists, and using both is not a
   fault.
2. **The identity warning names the working directory.** The CLI acts as the seat bound to the
   folder it runs in; from a teammate's Workspace it acts as them, and from an unbound folder it
   falls back to a read-only config identity. `musterd whoami` is the check.
3. **Guidance may not forbid what the team's own skills prescribe.** Where a shipped skill
   instructs a command, the standing context must permit it. `session orient-stamp` is named
   explicitly so the two cannot silently diverge again.

## Consequences

- The primer keeps the same three lines and stays inside both ADR 085 budgets. Both guards fired
  on the first draft — the line count at 35 (ceiling 35) and `primerBytes` at 2683 B (budget
  2665 B) — and both were answered by tightening the wording, not by raising a budget.
- Guidance content version 24 → 25. Every workspace's rendered skill files are stale until
  refreshed, which is the standing gap in lane `01M2NTZ9WV`, not a new one.
- The caution this retires is kept visible rather than deleted: `docs/design/agent-primer.md`
  records the ban, the caution that replaced it, and this retirement in sequence.
- Not decided here: whether `session orient-stamp` and the `stream *` verbs should gain MCP
  equivalents. This ADR makes the CLI legitimate for them; it does not argue they should stay
  CLI-only.

## Observability & Evaluation

**Traces** — none added. This is standing-context prose; it emits nothing.

**Eval** — baseline 2026-09-17: the shipped primer said "Use one channel only" while
`renderOrientSkill` in the same file prescribed `musterd session orient-stamp`. After: six tests
across `primer.test.ts` and `guidance.test.ts` assert the forbidding phrasings are absent, that
the cwd and `musterd whoami` are named, and that the orient skill's CLI command still appears —
each verified red before the change. Failure is any future edit that reintroduces "one channel
only", "do not drive both", or a claim that the registration carries a second identity.

**Experiment** — n/a. The claim is falsifiable by direct observation, not by traffic: run
`musterd whoami` from two sibling seat Workspaces. If both name the same member, the cwd does not
decide identity and Decision 2 is wrong.
