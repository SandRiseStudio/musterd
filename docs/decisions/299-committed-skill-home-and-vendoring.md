# 299 — `.agents/skills` is the committed skill home; upstream skill material is adapted, pinned, and licensed

- Status: accepted
- Date: 2026-08-21
- Deciders: nick (recipe approved in-session 2026-08-20/21), stanley (carried)
- Relates to: ADR 085 (the generated musterd-skill pipeline this deliberately stays outside of),
  ADR 012 (AGENTS.md primer, the codex-visible pointer surface), ADR 027 (non-invasive harness
  coexistence), ADR 296 (glossary as gated artifact — the authority this skill defers to), the
  product-communications role charter (roster `roles/product-communications.toml`, landed with
  Sloane inc 1)

## Context

Until now the repo had no committed skill. Every skill on disk — `.claude/skills/musterd*`,
`.cursor/rules/musterd.mdc`, `.musterd/skill/SKILL.md` — is machine-written by `musterd init`
from `packages/cli/src/onboard/guidance.ts` and gitignored (ADR 085's three-layer guidance
surface). That pipeline is the right home for musterd's own coordination guidance: one body,
per-harness frontmatter, regenerated on refresh.

The product-communications seat (sloane) needs a different kind of skill: reviewed *content
craft* — voice enforcement, editing passes, release-note sizing, press-release structure,
UX-copy specs — grounded in this repo's brand.md/PRODUCT.md/SPEC.md and adapted from external,
licensed skill repositories that gptbot surveyed on 2026-08-20. That material must be:

- **reviewed and versioned like code** — it makes claims about how the product speaks, so it
  needs PR review, not regeneration;
- **team-visible in one canonical place** — not a per-seat copy that drifts;
- **provenance-carrying** — it adapts MIT-licensed upstream work, which obliges us to preserve
  license texts and be able to say exactly which upstream revision we reviewed.

It cannot live under `.claude/skills/` (gitignored wholesale, and by ADR 085 that directory is
`musterd init`'s output, not an authoring surface). No existing ADR names a committed home for
skills, nor a policy for vendored third-party skill material.

## Decision

1. **`.agents/skills/<name>/` is the committed, harness-neutral home for reviewed skills.**
   The first resident is `product-communications`. The directory is repo content: authored on
   branches, reviewed in PRs, owned like any doc. `musterd init` never writes here.
2. **Per-harness bridges are thin pointers, provisioned per-seat — not repo content.** A seat
   that should load a committed skill gets a bridge in its own worktree (a `.claude/skills/`
   stub with frontmatter, a `.cursor/rules/*.mdc` stub, and for Codex an AGENTS.md pointer
   outside the musterd-managed markers), each of which says "read
   `.agents/skills/<name>/SKILL.md`" rather than duplicating the body. One canonical body, no
   three-copy drift — the same argument as ADR 085, applied to committed content.
3. **Vendoring policy for external skill material:** adapt, don't mirror. Upstream ideas and
   structure are rewritten for this repo's voice and charter; every adapted source is recorded
   in the skill's `PROVENANCE.md` with repo URL, reviewed commit SHA, license, and what was
   taken; license texts are preserved under the skill's `LICENSES/`. Wholesale file copies are
   not taken. Skill content must defer to the repo's authoritative message sources (brand.md,
   PRODUCT.md, SPEC.md, the ADR 296 glossary) — imported material never becomes a competing
   message source (the role charter's constraint, now structural).

## Consequences

- The repo gains its first committed skill: `.agents/skills/product-communications/`
  (SKILL.md + PROVENANCE.md + LICENSES/), adapted from four MIT-licensed upstreams pinned at
  their 2026-08-21 HEADs.
- Sloane's worktree gains the three thin bridges; no other worktree is touched. Other seats
  that later want the skill get the same bridges, not copies.
- ADR 085's generated pipeline is unchanged; nothing moves out of it. The two systems are
  distinguishable by one rule: **generated guidance is gitignored, reviewed content is
  committed.**
- Upstream drift is explicit: re-reviewing an upstream means updating its SHA in
  PROVENANCE.md in the same PR as any content it changes.
- Not decided here: any registry/marketplace of skills, auto-distribution of bridges by
  `musterd init`, or additional `.agents/` residents beyond `skills/`. Each needs its own
  decision when wanted.

## Observability & Evaluation

- **Traces:** none added — this ADR lands committed documents, not runtime behavior. The
  observable record is git itself: the skill directory's history, and PROVENANCE.md's pinned
  SHAs (falsifier: `git rev-parse HEAD` in a fresh clone of each upstream against the recorded
  SHA).
- **Eval:** n/a — purely mechanical/content ADR; no agent-facing runtime path changes. The
  skill's effect on sloane's output is judged by lane acceptance on that seat's deliverables
  (dataset: the seat's shipped public copy; baseline: pre-skill copy reviewed under the same
  brand.md §4 checks), not by an automated eval here.
- **Experiment:** n/a — no rollout risk; the change is additive committed content plus
  per-seat pointer files, reversible by `git revert` and deleting three bridge files.
