# Design — the agent primer (`musterd init` writes standing context)

> **Status:** ✅ implemented (`packages/cli/src/onboard/primer.ts` + init wiring; tests in `onboard/onboard.test.ts`). The **collision guard** (§7) remains unbuilt. Grounds out the 🔴 onboarding-gap finding in `docs/implementation-plan.md` §4.A item 3. Decision recorded in ADR 012.

## 1. Problem

A fresh Claude Code / Cursor agent dropped into a session where the musterd MCP tools are *available* doesn't know how to use them. It doesn't know it's on a team, doesn't know to `team_join`, doesn't know to check its inbox at task boundaries, and improvises in plain chat instead of using the acts. The tool *descriptions* are written for the agent, but a tool description is only read when the model is already deciding to call that tool — nothing gives the agent **standing context at session start**. This made the flagship 3-pane recording impossible to land (3 dead takes, 2026-06-12) and, more importantly, is what a real first user would hit.

The harness-native fix for "give an agent standing context every session" is the agent-context file the harness already reads on every run: **`AGENTS.md`** (the cross-tool convention — read by both Claude Code and Cursor). So: when `musterd init` wires an agent into a folder, it should also seed that folder's `AGENTS.md` with a musterd primer.

## 2. Decision

After a successful `configure()` (and in the manual-setup path), `musterd init` **writes or updates an `AGENTS.md` in the binding folder** (`process.cwd()` — the same folder Claude Code's `-s local` scope and Cursor's `.cursor/mcp.json` are keyed to) with a marker-delimited **musterd primer block** that teaches the agent its identity and the team working-loop. Idempotent, never clobbers the user's own content, gated behind a confirm (default yes).

Non-goals: we do **not** try to make the agent autonomous or script its behavior. The primer gives context; the agent still decides. We do **not** write per-harness rule files (`.cursor/rules/*.mdc`, etc.) in v1 — `AGENTS.md` covers both supported harnesses; a `Harness.primerPath()` hook is the extension point if that changes.

## 3. Where it's written

- **Path:** `<cwd>/AGENTS.md`, where `<cwd>` is the folder `init` is run in (already the binding folder for both harnesses — `claude mcp add -s local` keys on cwd; Cursor's `.cursor/mcp.json` is written under cwd).
- **One file, both harnesses.** Claude Code and Cursor both read `AGENTS.md`. No per-harness branching in v1.
- **Extension point:** add an optional `primerPath?(cwd: string): string` to the `Harness` interface (default → `join(cwd, 'AGENTS.md')`) if a future harness needs a different location. Not implemented in v1.

## 4. File format — marker-delimited, idempotent

The primer lives in a fenced, managed block so re-running `init` updates *only* that block and the user's own `AGENTS.md` prose is never touched:

```
<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->
…primer…
<!-- musterd:end -->
```

`upsertPrimer(dir, block)` behavior:
- **No `AGENTS.md`** → create it containing just the block (+ a trailing newline).
- **`AGENTS.md` exists, no markers** → append `\n` + the block (preserve all existing content above).
- **`AGENTS.md` exists, has markers** → replace the text between `musterd:start` and `musterd:end` in place.
- Returns `{ path, action: 'created' | 'appended' | 'updated' }` for the init report line.
- Pure string transform + one `readFileSync`/`writeFileSync`; best-effort, never throws into the flow (on error, fall back to printing the block for manual paste — same pattern as `printManual`).

## 5. The primer content (template)

`renderPrimer(binding: AgentBinding): string` produces the block. `{{role}}` clause omitted when role is empty. Keep it short and directive — agents have limited attention; this is a primer, not a manual.

```markdown
<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->
## Your musterd team

You are **{{member}}**{{, the {{role}}}} on the **{{team}}** team. musterd is your
coordination layer: your teammates — other agents *and* humans — are reachable through
the `team_*` tools in this session. Humans on the team are peers, not approvers.

Work as a teammate, not in isolation:

- **Join when you start.** Call `team_join` at the start of a working session so teammates
  can see you and reach you. (If this agent was set up with auto-join, you're already on.)
- **Check your inbox at every task boundary.** Call `team_inbox_check` when you start, when
  you finish a unit of work, and after you've been heads-down — messages addressed to you
  wait there and teammates expect a reply.
- **Say what you're doing.** Post `team_send {act:'status_update'}` when you pick up or finish
  work, so the team (and the human watching) can see progress.
- **Ask when you're blocked** with `team_send {act:'request_help'}` instead of guessing — it's
  visible to the whole team.
- **Hand off cleanly.** `team_send {act:'handoff'}` passes a unit of work (name the artifact);
  answer a `request_help` or `handoff` with `accept` / `decline` (set `reply_to`).
- **Close the loop when it's done.** `team_send {act:'resolve', thread:<id>}` marks a thread
  finished — accepting is not finishing. It clears the request from teammates' pending view.
- **See who's around** with `team_status` / `team_members` before you ask or hand off.

Keep messages short and purposeful. The acts are how the team coordinates — use them instead
of narrating in free text.
<!-- musterd:end -->
```

## 6. Init UX

In `onboard/init.ts`, after a successful `configure()` (right after the `scope` / `secretPath` lines):

1. Prompt: `p.confirm({ message: 'Write an AGENTS.md primer so ${name} knows how to use musterd?', initialValue: true })`.
2. On yes → `upsertPrimer(process.cwd(), renderPrimer(binding))`; report `p.log.success('${action} AGENTS.md — ${name} now has the team playbook (${path})')`.
3. On no, or on the **manual-setup** path (`printManual`) → include the rendered block in the printed instructions ("Add this to your AGENTS.md so the agent knows the playbook:") so the manual path isn't worse off.
4. The wait-for-join hint can then honestly say the agent has standing context (it no longer needs hand-holding to join/coordinate).

## 7. Related: the collision guard (same finding, scoped here, lower priority)

The recording also died on identity collisions — member names reused across folders (two `Ada`s, one auto-joining), tokens minted against a since-replaced db, orphaned adapters, a stray `inbox --watch` as the wrong member. The primer doesn't fix that; a small **init-time collision guard** does, and belongs to the same finding:

- **Name already bound elsewhere:** before minting, scan known binding locations (Claude `~/.claude.json` projects + discoverable `.cursor/mcp.json`) for a musterd server whose `MUSTERD_MEMBER` equals the proposed name on the same `MUSTERD_SERVER`/`MUSTERD_TEAM`. If found, warn: *"`<name>` is already wired into `<other folder>` — two folders sharing one member name is the 'N minds, one name' trap. Use a distinct name, or repoint that folder."*
- **Stale token / replaced db:** when `init` reuses a saved identity, verify the token still authenticates (`GET` a cheap authed endpoint); if it 401s, the db was likely replaced — offer to re-mint rather than silently binding a dead token.
- These are warnings/offers, not hard blocks. Full identity enforcement is the v0.3 seat model; this is the cheap operational guard that would have prevented the recording mess.

## 8. Implementation sketch

- **New file** `packages/cli/src/onboard/primer.ts`: `renderPrimer(binding): string`, `upsertPrimer(dir, block): { path; action }`. Pure + fs; no new deps.
- **Wire into** `onboard/init.ts` per §6; extend `printManual` to include the block.
- **(Optional, §7)** `onboard/collision.ts`: `scanMemberBindings(): {member; team; server; path}[]` over `~/.claude.json` projects; used to warn before mint.
- **Tests** (`onboard/onboard.test.ts` or a new `primer.test.ts`):
  - `renderPrimer` interpolates member/team and omits the role clause when empty.
  - `upsertPrimer` — creates when absent; appends below existing prose; updates in place between markers on re-run (idempotent: two upserts == one block); doesn't touch text outside the markers.
- **Docs to update in the same commit** (deviation protocol): `04-cli.md` `musterd init` step list (add "writes an `AGENTS.md` primer"), and `05-mcp.md` cross-link (the dormant→join→inbox loop the primer teaches). Note in `docs/demo.md` that the real 3-pane recording is unblocked once the primer ships.

## 9. Why this is the right shape

- **Harness-native.** `AGENTS.md` is already read every session by both supported harnesses — zero new moving parts at runtime, nothing to keep alive, nothing to reconnect. The primer is just context the model sees, the same way it sees the repo's own `AGENTS.md`.
- **Standing, not per-prompt.** It fixes the gap at its root (no context at session start) rather than papering over it with reminders in tool results.
- **Honest with the model.** It tells the agent the working loop in the agent's own terms (join → inbox at boundaries → status/request_help/handoff/accept), which is exactly what the failed recording showed agents don't infer on their own.
- **Composes with what exists.** Idempotent managed block sits alongside the user's own `AGENTS.md`; the `team_join` result and `harness-hooks.md` hooks remain complementary belts.

## 10. Future: agent-pullable primer (the Flue `flue add` pattern)

The §2 decision is a **push** — `init` writes standing context once, at setup time. A complementary **pull** path is worth considering later, modeled on Flue's `flue add` (source inspected 2026-06-17; see `docs/design/landscape.md` §4):

- Flue's CLI detects whether the caller is an AI agent (`@vercel/detect-agent`). If so it writes raw markdown instructions to **stdout** for the agent to act on; if a human, it prints `… --print | claude` pipe instructions instead.
- Instructions are **versioned** with a mandatory "Upgrade Guide" section, so they survive protocol drift rather than going stale like a one-shot file.

Applied to musterd, a `musterd primer --print` (same agent/human branching) would let an agent **self-onboard mid-session** — pull the current working-loop into its own context on demand — not only at `init` time. This closes two gaps the push model leaves open: an agent dropped into an already-configured repo whose `AGENTS.md` predates a SPEC change, and an agent that wants to re-read the loop after compaction. Lower priority than the collision guard (§7); recorded here so the option isn't re-derived from scratch. Not yet scoped to an ADR.
