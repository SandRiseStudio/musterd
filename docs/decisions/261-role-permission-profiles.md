# 261 — Role permission profiles: a floor every seat gets, a ceiling deny makes real

- Status: accepted
- Date: 2026-08-13
- Deciders: nick (directed), stanley (carried; consolidated from two parallel stanley drafts —
  this one and PR #792, closed in its favour — after an accidental same-seat session collision)
- Builds on: [ADR 026](026-role-templates.md)/[027](027-provision-reversibility.md)/[028](028-role-library-seed.md)
  (role templates carry `tools.permissions`; provisioning merges additively with manifest-tracked
  reversal — the machinery this ADR arms), [ADR 150](150-lane-ownership-gate.md) (the write gate
  this deliberately composes with), [ADR 171](171-provisioning-receipts.md) (the freshness frame
  increment 2 extends), [ADR 227](227-roles-and-stewardship.md) (roles as the daemon-side home),
  [ADR 063](063-observer-seats.md) (the read-only precedent),
  [ADR 255](255-config-json-concurrent-save.md) (read→merge→write posture).

## Context

On 2026-08-13, ryder's seat was blocked for hours: `Write` denied on `docs/wiki/*` in a
non-interactive session, presenting as a broken tool. The musterd side was innocent — the lane
owned `docs/wiki/**`, so the ADR 150 gate allowed the write. The denial came from the harness
permission layer: the seat's `.claude/settings.local.json` had hooks and **no `permissions` block
at all**, and a non-interactive session cannot prompt, so it fails closed. Correctly, and silently.

Three permission layers exist, and musterd owns only two:

| Layer                           | Mechanism                                        | Owner      |
| ------------------------------- | ------------------------------------------------ | ---------- |
| capabilities → MCP tool surface | `scopeToolSurface` (`packages/mcp/src/scope.ts`) | musterd    |
| lane surface → file writes      | ADR 150 PreToolUse hook                          | musterd    |
| harness allow/ask/deny          | `.claude/settings.local.json`                    | **nobody** |

They compose as **AND**, so drift in the unowned layer always fails closed and always
misattributes — the agent, the human, and the logs all blame a layer that was innocent.

**Most of the machinery already existed and was disarmed four ways.** ADR 026/028 shipped
`tools.permissions {allow, ask, deny}` on role templates, and `provisionRoleTools`
(`packages/cli/src/onboard/init.ts`) already merges them into `settings.local.json` through
`claudeCode.provision` — additive, manifest-tracked (ADR 030). But:

1. **It only fires from interactive `init` with a role template chosen.** `musterd agent <seat>` —
   how every agent seat is actually made — never provisions any of it.
2. **`generalist`, the default, declares no permissions.** So the common case gets nothing.
3. **The seed library's rule strings have never matched anything.** `'read'`, `'edit'`,
   `'bash(git diff*)'` are lowercase; Claude Code permission rules are exact tool names (`Read`,
   `Edit`, `Bash(git diff *)`), and no translation layer exists. Every entry ever provisioned from
   the seed roles was inert — the reviewer role's quasi-ceiling has never worked.
4. **ADR 171 freshness covers hooks only.** A missing permissions block is invisible to `--check`.

Every seat's allowlist is therefore an accident of which prompts a human happened to approve:
stanley and miley carry long accumulated lists; izzo and ryder had none.

## Decision

**A role carries a tool-access profile, and provisioning compiles it into the seat's harness
settings.** The harness block becomes a compiled artifact, never hand-maintained. Everything
below derives from one role definition.

1. **Canonical rule syntax, verbatim.** Role permission entries are written — and the seed library
   corrected — in Claude Code's own rule form: `Read`, `Edit`, `Write`, `NotebookEdit`,
   `Bash(<prefix> *)`, `mcp__<server>__<tool>`. No translation layer to drift; the compiled block
   is diffable against the template by eye.
2. **A `standard` floor, applied to every claude-code seat at provisioning, independent of role.**
   What a working seat needs to function non-interactively: the musterd MCP tools, the enforced
   git loop (ADR 106), the repo gates (`pnpm` build/test/lint/format), read access. The floor is
   **allow-only — it never carries `deny`** — so it merges under any ceiling.
3. **A `read-only` profile, made real by `deny`.** `deny: [Edit, Write, NotebookEdit]` plus `Bash`
   (or `Bash` narrowed to read-shaped prefixes: `git diff`/`log`/`show`, `ls`, `rg`). Deny outranks
   allow in Claude Code's precedence and cannot be overridden interactively — that precedence is
   what makes a ceiling a ceiling. The existing merge is documented as deliberately additive ("not
   a clamp", ADR 026 §4); **this ADR supersedes that comment on purpose**: the ceiling is the part
   that clamps, and it clamps through `deny` while the merge itself stays additive.
4. **`musterd agent` provisions the floor — plus role permissions when `--role` is given — into
   the new worktree's `settings.local.json`.** Dir-aware merge (the target is never
   `process.cwd()`), merge-never-clobber (all hook groups and every entry outside the profile's
   vocabulary survive, mechanically — the shape of nick's manual unblock is what provisioning must
   produce on its own), best-effort like hook install: a permissions hiccup never fails seat
   creation.
5. **Deny is authoritative; surplus allows are kept, not stripped** (nick, 2026-08-13).
   User-approved `allow` entries that exceed a ceiling stay in place — `deny` beats `allow`
   regardless of what else is in the file, so they are inert, and re-promotion restores them for
   free. Stripping would delete entries a human approved at a prompt, silently, on a schedule they
   did not choose — reintroducing the exact misattributed silent failure this ADR exists to end.
   Increment 2's `--check` reports them as drift for a human to resolve.

### Increment 2 (recorded, not built here)

- **ADR 171 freshness extends to the compiled block** — `musterd init --check` reports a
  missing/stale floor as a finding distinct from hook drift, **naming the layer** (the whole cost
  of the original incident was hours spent looking at the wrong one); `--refresh-hooks` or a
  sibling flag repairs it.
- **Role reassignment recompiles** — including the roster-home `role assign` path (known trap: it
  re-roles a seat without re-provisioning, leaving the old ceiling in force).
- **The same profile drives capabilities** (ADR 144 inc 5): a read-only role also drops
  `lane_claim`/`lane_submit`/`lane_resolve` from its MCP surface, so the two musterd-owned layers
  cannot drift from each other. Deferred with the reassignment work because both need the daemon,
  not the CLI's template file, as the profile's source of truth.

## Alternatives rejected

- **Gating `Write`/`Edit`/`Bash` via MCP capabilities** — structurally unavailable: harness-native
  tools deny before anything musterd owns is consulted. The compiled settings block and the ADR
  150 hook are the only mechanisms that reach them.
- **Stripping over-ceiling allows at recompile** — see decision 5; the argument to answer if this
  is ever revisited is the silent deletion of human-approved state.
- **Role-differentiated file-access globs in the harness block** — ADR 150's lane surface is
  per-claim and provenance-tied, strictly finer than any static role scope. Ceiling answers "may
  this seat write at all"; lane surface answers "here, now". They compose; they do not duplicate.
- **A translation layer from friendly names (`read`) to rule syntax** — a second vocabulary that
  can drift from the harness's own; defect 3 above is what the absence of a translation layer
  looks like when the vocabulary is wrong instead.

## Interaction with ADR 260 (named, not resolved here)

A read-only role cannot accept lanes, so it must not appear in `pickReviewCounterpart`'s candidate
pool — **eligibility must read the profile, not just presence**, or an unspendable candidate is
the ADR 260 failure in a new costume (and waking one for an acceptance ask is the ADR 252 failure
with extra steps). Surfaces do not collide (this ADR: `packages/cli/src/onboard/**`; the quiet-set
arc: `packages/server/src/store/review.ts`), but the designs must agree; wanderer owns the
review-path side.

## Observability & Evaluation

- **Traces:** the ADR 030 manifest records exactly which entries each provision added, per list —
  the audit trail and the exact-reversal record. A recompile logs what it changed. No new audit
  actions.
- **Eval:** the falsifiable claim is narrow — **no seat blocked by a missing harness permission
  again**. Baseline 2026-08-13: 2 of 4 active agent seats had no permissions block at all; ryder's
  incident is the only counted case, and it is also the only one anybody *noticed* — the counter
  has never been instrumented, and silence is not evidence (`docs/wiki/instrument-silence.md`).
  Instrument first: a denial nobody records is the failure mode being fixed.
- **The reading that would indict this ADR:** a steady stream of surplus-`allow` drift findings —
  each one is a human approving something the profile did not anticipate. That means the profiles
  are wrong, not the humans.
- **Falsifier for the syntax claim (defect 3):** if lowercase `'read'` demonstrably gates a `Read`
  call in a current Claude Code build, the seed-library correction is cosmetic — record it and
  keep canonical form anyway for diffability.

## Consequences

- Provisioning gains write authority over a file humans also edit — which is why decisions 4 and 5
  are conservative: musterd owns `deny` and its own entries, and reports the rest.
- Seats provisioned by `musterd agent` become usable non-interactively on day one; the ryder
  incident class closes at the source instead of by hand-editing a seat's settings.
- Roles stop being a charter-plus-MCP-servers convenience and become load-bearing for what a seat
  can do. Getting a profile wrong now blocks a seat rather than mislabelling it — the argument for
  increment 2's freshness check being loud and layer-naming.
- The reviewer seed role's ceiling becomes real for the first time; a seat that quietly relied on
  interactive `ask` prompts to edit will feel it. That is the ceiling working; `role create` and
  editing the template is the escape hatch (ADR 028).
- Existing seats are untouched until re-provisioned; increment 2's `--check` is what will surface
  them.
