# Terminology architecture — one meaning per word, one word per meaning

**Date:** 2026-08-21 · **Author:** stanley, from a design conversation with nick
**Status:** spec for review — becomes its own ADR when accepted; implementation follows the plan
**Context:** downstream of the Sloane-plan takeover (gptbot msg 01M0JHNY3C) and ahead of launch.
Companion decisions referenced: ADR 227 (roles), ADR 261 (permission profiles), ADR 272
(roles/profiles boundary), brand.md §5 / SPEC.md (the canonical glossary).

## 1. Problem

The vocabulary grew by accretion and now manufactures confusion — for the team's own admin, so
certainly for a launch-day stranger:

- **agent / member / seat** — three words orbiting one idea, with "agent" doing two jobs (industry
  hook *and* generic noun), so sentences true of humans and services get written about "agents."
- **role vs profile** — the live confusion that triggered this spec ("those sound like roles to
  me, no?"). "Profile" is among the most overloaded words in software and teaches nothing about
  what it configures; ADR 261 even uses it a third way ("permission profiles"). The CLI still
  keeps *two worlds under one name*: `musterd role create` scaffolds a **profile**.
- **surface** — three live meanings: the glossary's (where a member is present), the lane's
  `surface_globs` (which files), and marketing's "launch surfaces."
- **capability vs permissions vs MCP tool access** — three layers with no per-layer names; ADR
  261's founding incident was hours lost to not knowing which layer said no.
- **harness vs how-it-runs** — Claude Code desktop and Claude Code terminal are one harness with
  different abilities (session-label sweeping works on desktop, not terminal; a Cursor seat driven
  from `cursor-agent` CLI is invisible to hook capture). The axis exists on the wire
  (`presence.driver`) but not in the vocabulary.
- The canonical glossary (brand.md §5, mirrored normatively in SPEC.md) covers five terms while
  roughly twelve are load-bearing — and it is prose, so it has already drifted: the Member row
  still says `role (free text)` (superseded by ADR 227's `roles[]`), and the Act list predates
  `ask`.

## 2. Decision rule

**One meaning per word, one word per meaning, enforced.** Every canonical term carries a
definition and a **Not** column naming its banned synonyms and banned second meanings. New and
touched user-facing surfaces MUST use canonical vocabulary (the ratchet). History is never
rewritten: old ADRs keep their words; corrections invalidate-date, per the wiki's own rule.

Audience resolution (decided): the stranger's comprehension wins at the surface, and internal
vocabulary converges on the same words over time — one destination vocabulary, drift tolerated
only in the not-yet-touched past. No permanent translation layer: ADR 261 records what a second
vocabulary costs.

## 3. The vocabulary

The canonical five (Team, Member, Presence, Surface, Act) stay. The glossary extends to the
load-bearing set:

| Term | Meaning | Not |
| --- | --- | --- |
| **agent** | The industry hook, and a *kind* of member (`agent · human · service`). Marketing copy leads with it. | Not the generic noun for team participants — any sentence also true of humans or services says *member*. |
| **member** | Anyone on the roster — the canonical noun. Carries the thesis: humans and agents as peers on one team. | Not "agent"; not "seat". |
| **seat** | The durable position a member keeps — exists while they are away; claimed, adopted, handed off, woken. Used only where durability or occupancy is the subject. | Not a synonym for member; not a license unit ("a seat at the table", not "a seat license"). |
| **role** | A responsibility the team grants a member: charter + ceiling. Team-side, reviewed, harness-independent. May name a `default_toolkit`. | Not workspace setup; never granted by a local file. |
| **toolkit** | What a workspace is equipped with: MCP servers, tools, allow-entries. No authority — installing one grants nothing. | Not "profile" (legacy), not "kit", not "template". |
| **workspace** | The folder a seat is bound to. | Not "worktree" (git implementation detail, mentioned once in docs). |
| **harness** | The agent runtime family: Claude Code, Cursor, Codex. | Not "surface"; not "platform". |
| **driver** | How a harness session runs: desktop, terminal, IDE, headless. Already the wire field (`presence.driver`). | Not a harness; not a surface. |
| **surface** | Where a member touches the team: an agent's harness; a human's musterd CLI or web. Glossary meaning only. | Not the files a lane touches; not marketing channels (say *channels*, or name them). |
| **scope** | The paths a lane may touch (today's `surface_globs`). | Not "surface". |
| **permissions** | The harness-native allow/ask/deny rules musterd compiles into the workspace (ADR 261). | Not "capabilities". |
| **capability** | Team-granted authority on a member, enforced by musterd itself (`is_admin`, MCP tool scoping). Internal/protocol vocabulary; user-facing prose says what it means instead. | Not tool wiring; not harness rules; not per-driver feature support. |

Three structural rules the table encodes:

1. **The three-jobs rule.** Agent is the hook and the kind; member is the noun; seat is the
   mechanism. The pitch sentence uses all three once: *"musterd puts your AI agents and humans on
   one persistent team. Everyone on it is a member; every member keeps a seat — it's there when
   they're away, and it can be handed off, woken, or adopted."*
2. **Installed / allowed / authorized.** MCP tool access exists at three layers, one verb each:
   the **toolkit** *installs* a server; **permissions** decide whether the harness *allows* a
   call; a **capability** is what the team has *authorized* the member to do, enforced daemon-side
   and true on every machine. They compose as AND. (The recorded ADR 261 inc-2 unification — the
   role ceiling driving both deny-rules and capability scoping — is unchanged and stays deferred.)
3. **Safe derivation direction.** Role → toolkit is a convenience (`default_toolkit`); toolkit →
   role is the pre-ADR-272 defect (a local unreviewed file asserting a team responsibility) and
   stays impossible.

Per-driver feature differences (session labeling, hook capture, skills discovery) are neither
capabilities nor configuration: they are **observed environment facts**. They are documented in a
**support matrix** (features × harness × driver) and, if ever modeled, ride **presence
attestation** — the seat attests what its environment supports, the model-attestation pattern.
Reserved here; not built by this spec.

## 4. Enforcement — the ratchet with teeth

A migration norm without machinery never lands. Three mechanical pieces:

1. **Machine-readable glossary.** One source file (shape follows `docs/controls/registry.ts`)
   listing every term with `status: canonical | legacy-alias | banned`, definition, and Not
   column. brand.md §5 and SPEC.md's terminology section are generated from it or checked against
   it — prose can no longer drift silently. The known drift (Member's `role (free text)`, the
   stale Act list) is fixed in the same pass.
2. **Diff-aware lint** (`pnpm glossary:check`, alongside `wiki:check` / `roadmap-truth:check`).
   Touched files cannot *introduce* banned terms in user-facing text (docs/**, web strings, CLI
   help and render strings); existing uses are counted as a burn-down on main. Regression becomes
   impossible; progress becomes a number.
3. **A controls-registry entry with an expiry.** The burn-down carries a landing bound the build
   enforces (the `neverExercisedSince` aging pattern). A stalled migration is loud, not silent.

**Tiered landing** — "lands" means something different per tier:

- **Tier 1 — docs, CLI help, web strings:** migrate actively under the lint; bound ~45 days.
- **Tier 2 — wire tokens and file keys** (`surface_globs` → `scope`; profile keys → toolkit):
  migrate only when touched, with feature-epoch bumps and legacy accepted on read (the
  `idle → active` rename and `adoptLegacyRoleKey` are the worked examples). No calendar bound.
- **Tier 3 — internal identifiers:** opportunistic; some may never migrate. Users never see them.

Agents forgetting is handled twice over: the canonical table rides in the rendered musterd
guidance every seat gets at session start, and the lint catches whoever forgets anyway.

## 5. First renames (authorized when this spec's ADR is accepted)

1. **`musterd toolkit <create|list|show>`** owns workspace equipment; **`musterd role
   <list|show|assign>`** becomes roster-only. The "two worlds under one name" seam
   (`role create` scaffolding a profile) dies. `role create` prints a pointer for one release.
2. **Toolkit vocabulary in onboarding:** `.musterd/toolkits/*.json` preferred; `profiles/` and
   legacy `roles/*.json` still load (extend the existing legacy chain). `musterd agent --toolkit`
   with `--profile` as a quiet alias.
3. **Glossary regeneration** of brand.md §5 / SPEC.md from the source file, drift fixed.
4. **Docs sweep** for "agent" as generic noun and for non-glossary "surface" in user-facing text —
   tier 1, under the lint.
5. **`scope` on lanes** — tier 2, on-touch only.

## 6. Explicitly out of scope

- The support-matrix document itself (features × harness × driver) — a launch-docs deliverable in
  the product-communications (Sloane) charter, with the session-label/driver example as its first
  row.
- Driver-support attestation on presence — follow-up lane; pattern reserved above.
- `default_toolkit` on role files and the deny-migration (role clamps, toolkit adds) — decided
  direction, but they land with the Sloane role ADR, which is the ADR-227-touching ADR that ADR
  261's closing note was waiting for.
- Any wire rename outside the on-touch rule.

## 7. Evaluation

- **Falsifiable claim:** after the lint lands, zero banned-term introductions merge to main
  (the lint's job), and the tier-1 burn-down reaches zero by its registry bound (the expiry's
  job). Either failing indicts the mechanism, not the team.
- **The confusion test:** the question that started this spec — "aren't profiles just roles?" —
  must be unaskable from the regenerated glossary alone: a reader who has seen only brand.md §5
  can answer it. Same for "why does session labeling work on my laptop and not my server?"
  (driver + support matrix).
- **The reading that would indict the vocabulary itself:** a steady stream of lint suppressions
  or Not-column edits — each one is usage voting against a chosen word. That means the word is
  wrong, not the users; revise the term, don't relax the lint.

## 8. Open questions

- None blocking. The one recorded contingency: if pricing (lane 01M08Y95JD) lands per-seat, the
  word "seat" becomes an asset; if pricing makes the collision painful, that is the single
  trigger to revisit "seat" — recorded here so the revisit cites a trigger, not a mood.
