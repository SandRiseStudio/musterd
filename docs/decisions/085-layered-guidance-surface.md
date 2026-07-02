# 085 — A layered guidance surface: primer, skill, help, hooks — one fact per layer

- Status: accepted
- Date: 2026-07-02

## Context

musterd teaches an agent how to be a teammate through several mechanisms that all reduce to "text or
tools placed in front of the model," each with different loading semantics:

- **MCP** (`team_*` / `lane_*` tools) — the hands. Capability, always in context when the server is wired.
- **The AGENTS.md primer** (`renderPrimer`, ADR 012) — always-loaded standing context, written by `musterd init`.
- **Hooks** (SessionStart verify, ADR 060; Notification nudge, ADR 053) — deterministic enforcement the model can't skip.

Two of the five mechanisms in the wider agent-tooling ecosystem were missing: an on-demand **skill**
(the harness reads its name+description every session but loads the body only when the task matches) and
human-triggered **slash commands**. The gap they leave is the standing "biggest UX gap" the dogfood
notes keep hitting: a fresh agent that only has the primer doesn't know the _depth_ — how to claim or
adopt a seat (a `conflict` maze cost an agent ~5 min and DB surgery before ADR 055), how to hand off with
the branch attached, how to recover from a pending-approval or identity-drift. That depth can't go in the
primer: the primer is **always loaded**, so every line is a per-session token tax, and it was already
~50 lines carrying more than a kernel should.

The complication: musterd is evolving fast. Any written guidance risks drifting from the platform —
naming a command that got renamed, describing a flow that changed. Hand-authored docs rot silently.

## Problem

Add the skill + slash-command layers, slim the primer to a kernel, and do it so the generated guidance
**can't silently drift** from the CLI/MCP surface it describes — without duplicating the same fact across
three places that then disagree.

## Decision

**One doctrine: each fact lives in exactly one layer.**

| Layer                                       | Role                                                                                                      | Loading                                | Source                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| **Primer** (AGENTS.md + MCP `instructions`) | the loop _kernel_ — identity, channel rule, join/inbox/status/handoff one-liners, a pointer to the skill  | always loaded                          | `renderPrimer` (`@musterd/protocol`)    |
| **Skill**                                   | on-demand _playbooks_ — seat claiming/adoption, lane contention, handoff-with-branch, wait loop, recovery | name+description always; body on match | `renderSkillBody` (`@musterd/protocol`) |
| **CLI `help`**                              | flag-level _reference_                                                                                    | on `musterd help`                      | `HELP` (`packages/cli/src/help.ts`)     |
| **Hooks**                                   | _enforcement_ of the loop at task boundaries                                                              | fires mechanically                     | harness settings (ADR 053/060)          |
| **MCP**                                     | _capability_                                                                                              | tool schemas at session start          | `@musterd/mcp`                          |

**No fact is written in two layers except command/tool _names_** — and those are the one thing CI can
verify, which is exactly why they're the allowed duplication. The skill _names_ a command and gives its
one-line intent; the flags stay in `musterd help`. It does not inline flag lists.

**Generate from versioned source, stamp, and drift-check** (the primer / roadmap / arch-trees philosophy):

- The skill and slash-command **templates are pure renderers in `@musterd/protocol`**, single-sourced
  with the primer, stamped with a monotonic `GUIDANCE_CONTENT_VERSION`.
- `musterd init` writes **one canonical body into N thin per-harness shells**: `.claude/skills/musterd/SKILL.md`
  (Claude Code skill), `.cursor/rules/musterd.mdc` (Cursor description-gated rule), and always the
  harness-neutral `.musterd/skill/SKILL.md` that the primer points at (covers Codex — no skill mechanism —
  and any future harness). Slash commands land in `.claude/commands/` and `.cursor/commands/`.
- Every written file carries a content **stamp** (`<!-- musterd:content vN sha256:… -->`). Files are
  _wholly_ musterd's (unlike AGENTS.md, where user prose lives around our markers), so init overwrites in
  full — but only stamped files; a stampless file at the same path is treated as the user's and kept.
- `musterd init --check` (the ADR 060 doctor) reports **guidance drift**: a stamped version behind the
  current template, or a recorded file gone missing, is actionable **drift** (exit 1 — re-run init); a
  file hand-edited since we wrote it (body no longer hashes to its own stamp) is a warn-only **note**.
- `pnpm guidance:check` (wired into `format:check`) asserts every name in the skill's `SKILL_CLI_COMMANDS`
  is in `HELP` and every name in `SKILL_MCP_TOOLS` is a registered tool (`TOOL_NAMES`, pinned to the live
  server registry by `mcp.test.ts`). **Rename a command or tool and the build breaks** instead of shipping
  a skill that tells an agent to run something that no longer exists. A snapshot test forces a
  `GUIDANCE_CONTENT_VERSION` bump whenever the rendered prose changes, so the doctor's stale-version check
  stays meaningful.

## Alternatives considered

- **Fat primer** — keep piling depth into AGENTS.md. Rejected: it's always-loaded, so it taxes every
  session, and it was already over-long. The whole point of a skill is pay-on-use depth.
- **Hand-written per-harness files** — author `.claude`/`.cursor` guidance by hand. Rejected: three copies
  drift from each other and from the CLI; the generate-and-stamp path is what makes drift _visible_.
- **Docs-site link only** — have the skill say "see the docs." Rejected: agents don't leave the session to
  read a website; the guidance has to be in the workspace.

## Consequences

- The primer shrinks to a kernel (~30 lines) and gains a skill pointer; the MCP `instructions` surface
  inherits the shrink for free (same renderer).
- **Version-bump discipline**: changing skill prose requires bumping `GUIDANCE_CONTENT_VERSION` (the
  snapshot test enforces it). This is the deliberate cost that keeps drift detection honest.
- `musterd uninstall` gains a stamp-gated guidance removal (ADR 027 reversibility) recorded in the manifest.
- Staleness is _bounded, not eliminated_: CI catches name drift and version drift; behavioral drift in the
  playbook prose still relies on the author bumping the version when they change it.
- Codex is covered by the canonical file + primer pointer only (no native skill/command mechanism) — an
  explicit, documented degradation, not a gap.

## Observability & Evaluation

n/a — a provisioning/authoring-surface change: which files `musterd init` writes into a workspace and two
static drift checks (`init --check` guidance section; `pnpm guidance:check`). It emits no coordination
acts, opens no team-task spans, and changes no runtime agent behavior — the skill only changes what
standing/on-demand _text_ an agent can read, so there is nothing new to trace, score, or run an experiment
on. Whether the skill actually improves how agents claim/hand-off is measured the same way the gap was
found: dogfooding (the live check in this ADR's verification), not a metric. If a coordination-quality
eval later exists (ADR 051/052), "does the skill reduce wasted-work / claim-time" is a natural dataset for
it, but that engine isn't built yet.
