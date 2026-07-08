# AGENTS.md — Execution Contract

You are an agent implementing **musterd**. This file is the contract. Follow it literally. The docs are written so you can execute end-to-end **without judgment calls** — when you find yourself about to make one, stop and write an ADR instead (see "Deviation protocol").

## Read order (do this before writing any code)

1. `docs/architecture/00-overview.md` → `01` → `02` → `03` → `04` → `05` → `06` → `07` (in order).
2. `docs/design/brand.md` (glossary §5 + ANSI mapping §2 are load-bearing for the CLI).
3. `SPEC.md` (the normative protocol; `02-protocol.md` is its implementation-facing distillation).
4. The relevant `docs/design/figma-brief-*.md` when touching that surface.

The five glossary terms — **Team, Member, Presence, Surface, Act** — mean exactly one thing each (`brand.md` §5). Use them, and only them, in code and prose.

## Build order (strict — do not start a package until the one above passes its acceptance tests)

1. **`@musterd/protocol`** — types + zod schemas (`02-protocol.md`). The contract; everything imports it.
2. **`@musterd/server`** — SQLite store + WS/HTTP + presence + inbox (`01`, `03`).
3. **`musterd` (CLI)** — human surface (`04`). Done when two humans on one team exchange messages.
4. **`@musterd/mcp`** — universal adapter (`05`). Done when Claude Code joins, then Codex joins, the same team.

Only `@musterd/protocol` is imported across package boundaries. The CLI and MCP talk to the server **over the wire**, never by importing `@musterd/server`.

## Verification command per milestone

| Milestone  | Verify with                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| protocol   | `pnpm --filter @musterd/protocol test` (act-meta rules, envelope round-trip, version pin; ≥95% lines) |
| server     | `pnpm --filter @musterd/server test` (`03-server.md` acceptance list; ≥85%)                           |
| cli        | `pnpm --filter @musterd/cli test` + Scenario A (`06-testing.md`) + Figma terminal snapshot match      |
| mcp        | `pnpm --filter @musterd/mcp test` + Scenario B                                                        |
| flagship   | `pnpm test:scenarios` (Scenario C — the 3-pane demo as an automated test)                             |
| any "done" | `pnpm -r build && pnpm -r lint && pnpm test` all green                                                |

A milestone is **done** only when the `07-conventions.md` "Definition of done" checklist is fully satisfied.

## Running the CLI from source (local dev / dogfooding)

To exercise your source build (not the published `@musterd/cli`, which lags `main`):

```bash
pnpm -r build                          # or: pnpm --filter @musterd/cli build
node packages/cli/dist/bin.js <cmd>    # e.g. node packages/cli/dist/bin.js status

# or put a real `musterd` on PATH (run from the package dir — NOT with --filter):
pnpm -C packages/cli link --global     # `pnpm --filter @musterd/cli link --global` fails: Unknown option 'recursive'
pnpm -C packages/cli unlink --global   # to undo
```

`link --global` is a one-time global registration; `-C` is relative to your cwd, so to dogfood in **another** project use the absolute path (the relative form only works from the musterd repo root):

```bash
pnpm -C /ABS/PATH/TO/musterd/packages/cli link --global   # then `musterd <cmd>` works anywhere
pnpm bin -g                                                # if `musterd` is not found, ensure this dir is on $PATH (`pnpm setup`)
```

Isolate dogfood state from your real `~/.musterd` with env: `MUSTERD_CONFIG`, `MUSTERD_DB`, `MUSTERD_SERVER`/`MUSTERD_PORT`. Rebuild after any source change — the bin runs `dist/`, not `src/`.

## Hard rules (violating these is a bug, not a choice)

1. **Never change `@musterd/protocol` schemas without an ADR.** Other implementations depend on the protocol.
2. **CLI output must match the Figma terminal frames** (`figma-brief-terminal.md`). Snapshot tests enforce it; a divergence is resolved by fixing code or, with an ADR, the frame — never by silently letting them drift.
3. **Docs and code never disagree at the end of a commit.** A behavior change updates its doc in the same commit.
4. **Parse all external input** (frames, HTTP bodies, argv, MCP tool args) through `@musterd/protocol` zod schemas at the boundary. Never trust raw input.
5. **Never log secrets.** The team **agent key**, **grants**, and human **credentials** (`mskey_`/`msgr_`/`mscr_`) are shown once and stored only as `sha256` on the server / chmod-600 config on clients.
6. **No new runtime dependency without an ADR** noting why and the alternative considered.
7. **One Member is not one session.** Presence is where a Member is attached; the Member persists. Don't conflate them in schema, code, or naming.

## Course-correction / deviation protocol

When you find an error, contradiction, missing field, or a better approach:

1. **Do not silently deviate.**
2. Write `docs/decisions/NNN-<slug>.md` (sequential N; template in `07-conventions.md`): Context, Problem, Decision, Consequences.
3. Make the **smallest correct change**.
4. Update the affected doc(s) **in the same commit**, referencing the ADR in the commit footer (`Refs ADR-00N`).

Pre-flagged ADRs you will likely write: **001** (members table folds memberships — `01-data-model.md` already calls this out) and any dependency additions (`hono`, `cac`/`mri`, `tsup`, …).

## Where each doc lives (one job per doc — keep them from going stale)

Every doc has **one job and one lifecycle**, and **one fact has one home** — link, don't duplicate (duplication is what drifts and goes stale). Before adding to a doc, check it's the right home:

- **`SPEC.md`** — the single normative protocol (model, envelope, acts, transport, versioning). **Appendix A** holds _Unreleased_ (designed, not yet specified). Rewritten in place; every change is versioned **and** ADR-gated. There is no separate "draft spec."
- **`docs/decisions/NNN-*.md` (ADRs)** — the decision spine (_why_, dated). **Immutable once accepted — never edit a decision; supersede it with a new ADR.** They are the per-change record; don't re-narrate them elsewhere, link to them.
- **`docs/architecture/00–07`** — how it's built _now_ (impl-facing distillation of SPEC + structure). Rewritten to track code. The ``## File tree `packages/<pkg>/src/` `` blocks are **drift-checked**: `format:check` runs `arch-trees:check` (ADR 043), which fails if a tree omits a real source file or lists a stale one. Add a _described_ line for each new file — the descriptions are hand-authored (the checker enforces the file set, not the prose).
- **`docs/design/*`** — durable _why_: philosophy, research (Co-Gym, MAST), brand, landscape, deployment topology. Rarely changes; an exploratory design **freezes** once its decisions land in ADRs. **Not** a home for evolving plans or status.
- **`docs/archive/*`** — completed or superseded docs, kept for history. Do not maintain them.
- **`ROADMAP.md`** — what's next (reserved-but-unbuilt, out-of-scope-by-principle). Forward-looking; replaced, not accreted. **Its item list is generated** from `packages/web/src/content/roadmap.data.ts` — the single source of truth the web roadmap map also reads — via `pnpm roadmap:gen` (ADR 041). Edit the typed data module and regenerate; never hand-edit between the `<!-- GENERATED ROADMAP -->` markers (`format:check` runs `roadmap:check` to block drift).
- **`docs/implementation-plan.md`** — where we are _now_: a short, mostly-derived status snapshot + how we deviated (pointers to ADRs). Touch only when the milestone state changes.

New docs use the **canonical work-item vocabulary** (ADR 098): Goal / Lane are the entities, Phase / increment N the prose units — table in `07-conventions.md` §Naming, enforced by `pnpm vocab:check` (mention a banned word by backticking it).

**The four anti-patterns that made docs stale before — avoid all of them:** (1) a doc doing several jobs at once (status + findings-log + roadmap + index) — its parts have different lifecycles, so it accretes strikethroughs instead of being rewritten; (2) hand-narrating status that's derivable from ADRs / git tags / the test count; (3) re-narrating a decision a doc/plan when an ADR already records it; (4) two specs (a "live" and a "draft") hand-synced — there is one `SPEC.md`, and unreleased work is its Appendix A.

## What is out of scope for v1 (do not build — it's on `ROADMAP.md`)

Sandbox runtime, schedule **enforcement** (availability is stored, not enforced), team-to-team federation, iOS/web/Slack surfaces, the web dashboard _build_ (it's designed in Figma now, built later), Python SDK. Keep the schema fields that anticipate these; don't wire behavior to them.

## Definition of "the product works"

The three automated scenarios in `06-testing.md` pass: (A) two humans on one team, (B) agent + human request_help→accept loop, (C) the flagship 3-pane scenario across CLI + two MCP surfaces. Scenario C is both the final acceptance test and the script for the recorded README demo.

## Git workflow (one enforced way — see [ADR 106](docs/decisions/106-unified-git-workflow.md))

There is exactly one way to land a change. GitHub enforces it (squash-only, `main` protected, required
checks), so don't improvise a merge method or a catch-up strategy.

1. **Branch from fresh `main`, in your worktree.** `git fetch origin main` then `git checkout -b feat/<slug> origin/main` (or `fix/`/`docs/`). One branch per lane.
2. **Work and commit normally — as your seat.** Intermediate commits don't matter — the PR is **squash-merged** to one commit. Your worktree's git identity is your seat ([ADR 109](docs/decisions/109-seat-git-attribution.md)); end every commit message with your seat trailer `Co-authored-by: <seat> <seat@<team>.musterd>` (this replaces the generic model trailer — add a model line alongside if you like). The trailer is what survives the squash onto `main`, so keep it when editing a squash body.
3. **Before pushing, run the fast local gates:** `pnpm typecheck && pnpm format:check` (seconds). This is a *smoke test for speed*, not a duplicate of CI — do **not** run the full suite locally to "pre-verify" CI. CI is the authority.
4. **Open the PR and let it land itself:** `gh pr create …` then `gh pr merge <n> --squash --auto --delete-branch`. Auto-merge waits for the required checks (`gates` CI + `Cursor Bugbot`) and squash-merges when green. **Don't poll or babysit** — walk away; you'll be notified.
5. **Fell behind `main`? Rebase — never `merge main`:** `git fetch origin main && git rebase origin/main`, resolve conflicts once, re-run the fast gates, `git push --force-with-lease`. Your branch is throwaway history under squash, so rebasing is free; `--force-with-lease` won't clobber a teammate.
6. **When you resolve the lane, attest the merge:** pass `{pr, sha, authorized_by}` on the lane resolve so the audit log joins your seat to the landed SHA and the authorizing human (ADR 109; `authorized_by` defaults to your grant's issuer). Then **clear the *local* branch:** `git fetch origin main --prune && git switch --detach origin/main && git branch -D <branch>`. Auto-delete only removes the **remote** branch; the local one lingers. You can't `git checkout main` (a sibling worktree owns it) and `git branch -d` refuses a squash-merged branch — so **detach to fresh `origin/main`** (which is also step 1's start state) and force-delete. Between lanes your worktree rests detached at `origin/main`, not on a stale branch. `lane resolve` prints this line for you.

**Hard rules:** never merge with a merge-commit or rebase-merge (disabled anyway); never `git push --force` (use `--force-with-lease`); never merge past a red `gates` run or an unresolved Bugbot finding. Auto-delete clears the **remote** branch; you still clear the **local** one (step 6) — `git branch -d` won't (squash-merge isn't an ancestor), so use `-D` once the PR is merged. The `gates` check runs `build → typecheck → test → format:check`; Bugbot is the Cursor GitHub App (configured at cursor.com/dashboard/bugbot, **not** in-repo).

<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->

## Your musterd team

You are a member of the **revive** team — **claim your seat first** (`team_join`, or `musterd claim <name>` then `musterd status`; a seat is claimed with the team **agent key** — set `MUSTERD_AGENT_KEY` or pass `--key mskey_…`, and an admin approves if no grant was pre-issued) so teammates can see and reach you. musterd is your coordination layer: your teammates — other agents _and_ humans — are
reachable through it, and humans on the team are peers, not approvers.

**Your channel.** If this session has the `team_*` tools (the musterd MCP server), they are your
channel — use them. If it does not, coordinate with the `musterd` CLI instead. Use one channel only
— with the `team_*` tools, do not also drive the CLI (it can resolve to a different identity and your
sends will fail).

The loop — `team_*` tool form / `musterd` CLI form:

- **Get on the team when you start.** `team_join` / `musterd claim <name>` then `musterd status`, so
  teammates can see and reach you.
- **Check your inbox at every task boundary.** `team_inbox_check` / `musterd inbox` — on start, when
  you finish a unit of work, and after being heads-down. Directed acts wait there for a reply.
- **Report status as you work.** `team_send {act:'status_update'}` / `musterd send --act
status_update '<one line>'` on start and finish — this is what flips you to `working` on the roster.
- **Own your work in a lane** and **hand off cleanly.** `lane_open` / `musterd lane open` when you
  start; `team_send {act:'handoff'}` / `musterd send --act handoff` to pass work; close with `resolve`.

Invoke the tools/commands for real and use what they return — never write down an imagined inbox or
reply. Keep messages short: use the acts, do not narrate in free text.

**Going past the basics?** Claiming or adopting a seat, handing off with a branch, lane contention,
waiting on the inbox without polling, or recovering from an error — read the **musterd skill**
(`.claude/skills/musterd/SKILL.md`, `.cursor/rules/musterd.mdc`, or `.musterd/skill/SKILL.md`) or run
`musterd help` for the full command reference.

<!-- musterd:end -->
