# 261 — Role permission profiles: a floor every seat gets, a ceiling deny makes real

- Status: accepted
- Date: 2026-08-13
- Deciders: nick (directed), stanley (carried)
- Builds on: [ADR 026](026-role-templates.md)/[027](027-provision-reversibility.md)/[028](028-role-library-seed.md)
  (role templates carry `tools.permissions`; provisioning merges additively with manifest-tracked
  reversal — the machinery this ADR arms), [ADR 150](150-lane-ownership-gate.md) (the write gate
  this deliberately composes with), [ADR 171](171-provisioning-receipts.md) (the staleness frame
  increment 2 extends), [ADR 227](227-roles-and-stewardship.md) (roles as the daemon-side home),
  [ADR 063](063-observer-seats.md) (the read-only precedent).

## Context

On 2026-08-13, ryder's seat was blocked for hours: `Write` denied on `docs/wiki/*` in a
non-interactive session, presenting as a broken tool. The musterd side was innocent — the lane
owned `docs/wiki/**`, so the ADR 150 gate allowed the write. The denial came from the harness
permission layer: the seat's `.claude/settings.local.json` had hooks only and **no permissions
block at all**, and a non-interactive session cannot prompt, so it fails closed. Correctly, and
silently.

The structural fact: every seat's harness allowlist is an accident of interactive approvals.
stanley and miley carry long accumulated lists; izzo and ryder had none. Three permission layers
exist and they compose as AND — capabilities → MCP tool surface (ADR 144 inc 5), lane surface →
file writes (the ADR 150 hook), and the harness allow/deny block — so drift between them always
fails closed and always misattributes.

**Most of the fix already existed and was disarmed three ways.** ADR 026/028 shipped
`tools.permissions {allow, ask, deny}` on role templates, and `musterd init`'s role flow provisions
them through `mergePermissions` (additive, manifest-tracked). But:

1. **`musterd agent` — how every agent seat is actually made — never reaches that path.**
   `provisionWorkspace` wires binding, worktree, and MCP entry; permissions ride only the
   interactive `init` role picker.
2. **The builtin rule strings have never matched anything.** `'read'`, `'edit'`,
   `'bash(git diff*)'` are lowercase; Claude Code permission rules are exact tool names (`Read`,
   `Edit`, `Bash(git diff*)`), and no translation layer exists. Every entry ever provisioned from
   the seed library was inert.
3. **No floor, and no real ceiling.** `generalist` adds nothing — so a role-less non-interactive
   seat always fails closed on its first write. And the seed roles use `ask` where a ceiling needs
   `deny`: in a headless session, `ask` is just a slower fail-closed.

## Decision

Everything below compiles from **one role definition**; the harness block is a provisioned
artifact, never hand-maintained.

1. **Canonical rule syntax.** Role permission entries are written (and the seed library corrected)
   in Claude Code's own rule form — `Read`, `Edit`, `Write`, `NotebookEdit`,
   `Bash(<prefix> *)`, `mcp__<server>__<tool>` — verbatim strings, no translation layer to drift.
2. **A `standard` floor, applied to every claude-code seat at provisioning, independent of role.**
   The floor is what a working seat needs to function non-interactively: the musterd MCP tools, the
   enforced git loop (ADR 106), the repo gates (`pnpm` build/test/lint/format), and read access.
   It is an **allow floor only — it never carries `deny`**, so it can merge under any role ceiling.
3. **A `read-only` profile, made real by `deny`.** `deny: [Edit, Write, NotebookEdit, Bash]` plus
   an allow list of read-shaped Bash prefixes (`git diff`/`log`/`show`, `ls`, `rg`). Deny outranks
   allow in Claude Code's precedence and cannot be overridden interactively — that precedence is
   what makes a ceiling a ceiling. `ask` entries in seed roles are demoted to documentation of
   intent; ceilings use `deny`.
4. **`musterd agent` provisions the floor (plus role permissions when `--role` is given) into the
   new worktree's `settings.local.json`.** Dir-aware merge (the target is never `process.cwd()`),
   merge-never-clobber (user entries and all hook groups preserved — the ADR 255 posture),
   best-effort like hook install: a permissions hiccup never fails seat creation.
5. **Deny wins; allows are kept** (nick's call, 2026-08-13). Recompiling after a role change never
   strips user-approved allow entries that exceed the new ceiling — the compiled `deny` block
   already outranks them, so they are inert, and re-promotion restores them for free. Recompile
   stays a non-destructive write with no exception to merge-never-clobber.

### Increment 2 (recorded, not built here)

- **ADR 171 staleness extends to the compiled permissions block** — `musterd init --check` reports
  a missing/stale floor the way it reports stale hooks; `--refresh-hooks` (or a sibling flag)
  repairs it.
- **Role reassignment recompiles**, including the roster-home `role assign` path (known trap: it
  re-roles a seat without re-provisioning, leaving the old ceiling in force).
- **The same profile drives capabilities** (ADR 144 inc 5): a read-only role should also drop
  `lane_claim`/`lane_submit`/`lane_resolve` from its MCP surface, so the two musterd-owned layers
  derive from one definition. Deferred with the reassignment work because both need the daemon to
  be the profile's source of truth, not the CLI's template file.

## Alternatives rejected

- **Gating `Write`/`Edit`/`Bash` via MCP capabilities** — structurally unavailable: harness-native
  tools deny before anything musterd owns is consulted. The compiled settings block and the ADR 150
  hook are the only two mechanisms that reach them.
- **Stripping over-ceiling allows at recompile** — destroys human-approved state and makes
  recompile a destructive write; deny precedence already makes them inert.
- **Role-differentiated file-access in the harness block** — ADR 150's lane surface is per-claim
  and provenance-tied, strictly finer than any static role scope. The ceiling answers "may this
  seat write at all"; the lane surface answers "here, now". They compose; they do not duplicate.
- **A translation layer from friendly names (`read`) to rule syntax** — a second vocabulary that
  can drift from the harness's own. Verbatim rules make `settings.local.json` diffable against the
  template by eye.

## Interaction with ADR 260 (named, not resolved)

A read-only seat cannot accept lanes, which shrinks `pickReviewCounterpart`'s candidate pools and
changes what "eligible" means on the acceptance path — the same population ADR 260's eval measures.
Increment 2's capabilities work must land with the quiet-set arc in view: a role that cannot
`lane_resolve` must not be a wake target for an acceptance ask (waking a seat that cannot act is
the ADR 252 failure with extra steps).

## Observability & Evaluation

- **Traces:** the provisioning manifest (ADR 030) records exactly which entries each provision
  added, per list — that is the audit trail and the reversal record. No new audit actions.
- **Eval:** the incident class this exists to end is "non-interactive seat fails closed on a tool
  the floor should cover". Baseline 2026-08-13: 2 of 4 active agent seats had no permissions block
  at all (izzo, ryder); ryder lost a working session to it. Check: after the next provisioning
  sweep, every claude-code seat carries the floor (`musterd init --check` in increment 2 makes
  this a standing receipt rather than a one-off read).
- **Falsifier for the syntax claim:** if lowercase `'read'` in an allow list demonstrably gates a
  `Read` call in a current Claude Code build, decision 1's premise is wrong and the seed library
  correction is cosmetic — record it and keep the canonical form anyway for diffability.

## Consequences

- Seats provisioned by `musterd agent` become usable non-interactively on day one; the ryder
  incident class closes at the source instead of by hand-editing a seat's settings.
- The reviewer seed role's ceiling becomes real for the first time — which may surprise a reviewer
  seat that has been quietly relying on interactive `ask` prompts to edit. That is the ceiling
  working; `role create` + editing the template is the escape hatch, per ADR 028.
- Existing seats are untouched until re-provisioned (this ADR changes what provisioning writes,
  not any live file); increment 2's `--check` is what will surface them.
