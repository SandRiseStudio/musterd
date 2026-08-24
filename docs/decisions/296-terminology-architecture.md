# 296 — One meaning per word: the terminology architecture

- Status: accepted
- Date: 2026-08-21
- Deciders: nick (design conversation), stanley (carried)
- Spec: `docs/superpowers/specs/2026-08-21-terminology-architecture-design.md` (PR #962)
- Relates to: ADR 098 (the work-item vocabulary and the gate this extends), ADR 227 (roles as the
  aptitude layer), ADR 261 (the compiled permission layer — this ADR names its layers), ADR 272
  (the role/profile boundary — this ADR renames its workspace half), ADR 138 (clients render the
  wire token), brand.md §5 / SPEC.md (the canonical glossary this ADR grows)

## Context

The vocabulary grew by accretion. `SPEC.md:22` makes five terms normative — Team, Member,
Presence, Surface, Act — while roughly twelve are load-bearing, and the glossary that governs them
is prose, so it has already drifted (the Member row still says `role (free text)`, superseded by
ADR 227's `roles[]`; the Act row's list predates `ask`).

The cost is not hypothetical. In one design conversation on 2026-08-21 the team's own admin asked
"aren't those profiles just roles?" — about a distinction ADR 272 spent a revision cycle
establishing — and then asked where the desktop-vs-terminal difference lives, which the wire has
modeled as `presence.driver` for weeks with no word for it in any doc. Four collisions are live:
`agent` doing double duty as the industry hook *and* the generic noun for participants; `profile`
naming workspace equipment with a word that teaches nothing and that ADR 261 independently reuses
for permissions; `surface` carrying three meanings (presence location, a lane's `surface_globs`,
and marketing "launch surfaces"); and MCP tool access spanning three enforcement layers with no
per-layer names — the ambiguity that cost hours in ADR 261's founding incident, where the answer
to "which layer denied this?" was unavailable to the agent, the human, and the logs alike.

A launch-day stranger meets all of this at once.

## Decision

**One meaning per word, one word per meaning — with the Not column enforced, not merely
published.**

### 1. The vocabulary

The canonical five stay. The glossary grows to the load-bearing set, each term carrying a
definition and a **Not** column (banned synonyms and banned second meanings). The full table is
§3 of the spec; the terms it settles:

- **agent** — the industry hook, and a *kind* of member (`agent · human · service`). Not the
  generic noun: any sentence also true of humans or services says *member*.
- **member** — anyone on the roster, the canonical noun.
- **seat** — the durable position a member keeps; used only where durability or occupancy is the
  subject. Not a synonym for member, not a license unit.
- **role** — a responsibility the team grants: charter + ceiling, team-side and reviewed.
- **toolkit** — what a workspace is equipped with (MCP servers, tools, allow-entries), carrying
  no authority. Replaces "profile"; "kit" and "template" go in its Not column.
- **workspace** / **harness** / **driver** — the folder a seat is bound to; the runtime family
  (Claude Code, Cursor, Codex); and how a session runs (desktop, terminal, IDE, headless).
  `driver` is already the wire field; this ADR makes it vocabulary.
- **surface** — where a member touches the team, and nothing else. A lane's paths become its
  **scope**.
- **permissions** / **capability** — the harness-native compiled rules; and team-granted authority
  enforced daemon-side. `capability` is internal/protocol vocabulary.

Three structural rules the table encodes:

1. **Three jobs, three words.** Agent is the hook and the kind, member is the noun, seat is the
   mechanism. The pitch sentence uses each exactly once.
2. **Installed / allowed / authorized.** A **toolkit** *installs* an MCP server; **permissions**
   decide whether the harness *allows* a call; a **capability** is what the team has *authorized*,
   true of the member on every machine. They compose as AND. This names ADR 261's three layers
   without changing any of them.
3. **Derivation flows one way.** Role → toolkit is a convenience (a role may name a
   `default_toolkit`); toolkit → role is the pre-ADR-272 defect — a local unreviewed file
   asserting a team responsibility — and stays impossible.

Per-driver feature differences (session labeling, hook capture, skills discovery) are neither
capabilities nor configuration but **observed environment facts**: documented in a support matrix
and, if ever modeled, attested through presence like the model is. Reserved, not built here.

### 2. Enforcement extends ADR 098's gate; it does not add a second one

`scripts/check-vocab.ts` is already this mechanism for the work-item vocabulary — banned list,
mention-vs-use masking, `<!-- vocab:ok -->` suppression, grandfathering by ADR number and plan
date, and self-hosting from its own number. This ADR adds a second banned table (the Not columns)
and **widens the gated path set** to the user-facing strings the current gate leaves out: CLI help
and render strings, web UI strings, README, ROADMAP, AGENTS.md. Its path-and-date grandfathering
is kept in preference to diff-awareness — simpler, proven here, and it makes the burn-down a set
of named files rather than a heuristic. **ADR 296 self-hosts:** the new table gates ADRs from 296.

The migration carries a controls-registry entry with an expiry, so a stall is loud rather than
silent — the `neverExercisedSince` aging pattern from the controls work.

### 3. Landing is tiered, and history is never rewritten

- **Tier 1 — docs, CLI help, web strings:** migrate actively under the gate; bound ~45 days.
- **Tier 2 — wire tokens and file keys** (`surface_globs` → `scope`, profile keys → toolkit):
  on-touch only, with feature-epoch bumps and legacy accepted on read (ADR 138; the `idle→active`
  rename and `adoptLegacyRoleKey` are the worked examples). No calendar bound.
- **Tier 3 — internal identifiers:** opportunistic. Users never see them.

Old ADRs keep their words. Corrections invalidate-date rather than overwrite, per the wiki's rule.

## Alternatives rejected

- **A second vocabulary for strangers, stability underneath** (public docs clean, internals
  unchanged, with a mapping table) — the cheapest option, and it deliberately manufactures the
  seam that produced the confusion: `musterd role create` scaffolds a *profile* today precisely
  because two vocabularies met at one command. ADR 261 rejected a translation layer on the same
  ground and its §3 defect is what the absence of one looks like when the vocabulary is wrong.
- **Keep `profile`, always qualified as "workspace profile"** — the qualifier has already eroded
  in practice (everyone says "profile"), and erosion restores the ambiguity for free.
- **`kit` instead of `toolkit`** — collides with the launch deliverable already named "marketing
  asset kit", which is the disease being cured. `kit` goes in the Not column.
- **Promote `seat` to the headline noun** — evocative and differentiating, but it dethrones a
  canonical five-term, touches wire vocabulary, and "a team of seats" reads colder than members.
- **Rename everything at once, including internals** — one vocabulary sooner, at the cost of a
  big-bang rename across 290+ ADRs and the wire; the tiered ratchet reaches the same destination
  without a flag day.

## Observability & Evaluation

- **Traces:** none new. The gate is a build-time check; its output is the burn-down count and the
  controls-registry entry's last-exercised date. No new audit actions, no new spans.
- **Eval:** the falsifiable claim is narrow — after the extension lands, **zero banned-term
  introductions merge to main**, and the tier-1 burn-down reaches zero by its registry bound.
  Baseline is the burn-down count measured when the table lands. The **confusion test** is the
  qualitative half: the question that started this ADR ("aren't profiles just roles?") must be
  answerable from the regenerated glossary alone, as must "why does session labeling work on my
  laptop and not my server?" (driver + support matrix).
- **The reading that would indict this ADR:** a steady stream of `<!-- vocab:ok -->` suppressions
  or Not-column edits. Each one is usage voting against a chosen word — that indicts the word, not
  the writers; revise the term rather than relax the gate.
- **Experiment:** none — observational. A controlled comparison of vocabularies would need two
  populations of strangers musterd does not have pre-launch; the gate's counter and the confusion
  test carry the claim instead.

## Consequences

- `musterd toolkit <create|list|show>` owns workspace equipment and `musterd role` becomes
  roster-only, ending the "two worlds under one name" seam. `role create` prints a pointer for one
  release; `--profile` survives as a quiet alias.
- The glossary becomes a generated artifact rather than prose, and its existing drift is fixed in
  the same pass — the first thing the new gate does is make the old glossary honest.
- ADR 272's rename gets renamed: "profile" lasted one week as canonical. Pre-launch is the
  cheapest this will ever be, and the legacy-key machinery that migration built (`adoptLegacyRoleKey`)
  is reused rather than rebuilt.
- Glossary stewardship and the support matrix become product-communications charter work — the
  role that ADR-in-flight (Sloane) defines. The gate is what keeps that seat honest too.
- One contingency is recorded rather than left to mood: if pricing (lane 01M08Y95JD) lands
  per-seat, "seat" becomes an asset; if pricing makes the collision painful, that is the single
  trigger to revisit the word.

- **2026-08-21 (enforcement PR, wanderer, lane 01M0JT3RTC).** The gate extends `scripts/check-vocab.ts`
  rather than adding a second checker. The terminology table's `TERMINOLOGY_GATE_FROM` is **299**,
  not 296: 296 is the decision, and 296–298 had already landed (spec then two follow-ups) before
  this enforcement existed — the same split as obs-evals' ADR 052 vs `GATE_FROM` 60. A frozen
  `USER_FACING_BASELINE` is the tier-1 burn-down (CLI help/render, web copy, README/ROADMAP/AGENTS.md).
  `docs/glossary/terms.ts` is the glossary source; brand.md §5 is checked against it. The
  profile→toolkit CLI rename (`musterd toolkit`) is the next cut of this lane, not this commit —
  nick holds `packages/cli/src/help/catalog.ts` on 01M018624.

- **2026-08-21 (GATE_FROM bump, wanderer, lane 01M0JVYFECA).** ADR 299 landed on main minutes
  before the enforcement PR (`63d53ab6` then `5c755ce0`). Its frozen Decision uses unquoted
  `worktree` ("in its own worktree"). `TERMINOLOGY_GATE_FROM` 299 therefore failed `vocab:check`
  on main and on every following PR (dolly #975). Bumped to **300**. Cannot backtick the Decision;
  cannot leave the gate red.

- **2026-08-21 (toolkit split, stanley, lane 01M0K5X6D2).** The rename the enforcement PR deferred.
  `musterd toolkit <list|show|create>` now owns workspace equipment and `musterd role` is
  roster-only — the two worlds that shared one name are two commands. Four behaviour changes,
  each of them a fall-through this ADR called a seam: `role list` no longer prints equipment
  under the team library; `role show` no longer renders a toolkit when the roster has no such
  role, it names `musterd toolkit show`; `role create` outside a roster home is **refused**
  rather than silently downgraded to a workspace file (a local file may never assert a team
  responsibility — §1.3); and `role create --profile` survives as the quiet alias, delegating to
  the new command. `role create` in a roster home prints the one-release pointer.

  Scope held deliberately: this is the **command surface only**. `.musterd/profiles/` keeps its
  name on disk and `Profile`/`profile:` keep theirs in the schema — those are file keys, tier 2,
  landing on-touch with legacy accepted on read. Renaming them here would have been the flag day
  §3 rejects. Nine tests moved from `role.test.ts` to `toolkit.test.ts` rather than being
  deleted, so the split cost no coverage.

  Recorded because it nearly shipped silently: trimming the now-unused imports out of `role.ts`
  also removed two still in use, and `recompileSeatPermissions` catches around its template
  resolution — so the missing symbol presented as "this role has no provisioning template" and
  three ADR 261 tests failed with no mention of an import. Lint did not see it; `tsc` did. A
  catch that swallows a `ReferenceError` alongside the absence it is meant to tolerate will do
  this again.

- **2026-08-24 (toolkit file keys, stanley, lane 01M0K5YTZ2).** The file-key half the toolkit split
  deferred. Canonical toolkits are now `toolkit`-keyed JSON in `.musterd/toolkits/`, and that is
  the only shape written. Both older shapes still load — `profile`-keyed in `.musterd/profiles/`
  (ADR 272) and `role`-keyed in `.musterd/roles/` (pre-272) — so this is tier 2 as specified:
  legacy accepted on read, no flag day, no migration command. A file carrying more than one name
  key resolves on the newest it has, so a hand-merged file never silently adopts the oldest name.

  **The lane's own premise was wrong, and measuring first is what caught it.** The lane read
  "profile keys become toolkit keys in **seat and roster files**" and named
  `protocol/src/seatfile.ts`, `server/src/projection/*` and `cli/src/roster.ts` as its surface.
  Those files contain **no `profile` key at all** — their `role`/`roles` is the roster role, the
  one word ADR 296 §1 *keeps*. Renaming anything there would have corrupted the roster vocabulary
  in the name of fixing it. The real file keys were three, all in the workspace half: the toolkit
  JSON schema, the built-in seed library, and `provisioned.json`.

  **`provisioned.json` is deliberately NOT in this increment,** and the reason is a constraint
  worth writing down: `WorktreeProvisioningSchema` is `.strict()`, and its own contract says an
  unknown field is `invalid`, never `legacy`. So the dual-write that carried the ADR 272 rename in
  the v1 manifest (`{ role, profile, ... }`, safe because that reader strips unknown keys) is
  **impossible** under a strict schema — an older musterd meeting a `toolkit` key would report the
  file broken rather than old. Renaming that field needs a version-3 bump with v2 recognized as
  `legacy` and converted by `musterd harness configure`, which is exactly the path v1→v2 already
  walks. That is a separate increment, and it should not be started while the v1→v2 migration is
  still live.

  Also fixed here: `docs/architecture/04-cli.md` still documented `musterd role` doing the
  workspace-equipment job it stopped doing in the split three days earlier — the doc described
  behaviour that no longer existed, under the exact word this ADR is disambiguating. Two hand-rolled
  copies of the home list (in `role.ts` and the Claude Code adapter) were replaced by one exported
  `toolkitHomes()`, so a fourth home cannot be added to the loader and missed by a caller.

  Not renamed, and named here so it is not mistaken for an oversight: `musterd agent --profile` is
  a CLI token rather than a file key, and `Profile`/`parseProfile`/`loadProfile` are internal
  identifiers — tier 3, opportunistic.
