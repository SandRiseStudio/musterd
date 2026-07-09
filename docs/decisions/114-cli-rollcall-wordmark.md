# 114 — CLI wordmark: retire the block figlet for a roll-call lockup

- Status: accepted — supersedes the block-ASCII CLI banner; 2026-07-09
- Date: 2026-07-09

## Context

[ADR 113](113-cli-visual-system.md) gave the CLI a warm, scannable visual system but deliberately left
the wordmark alone ("no wordmark or palette change"). The wordmark it kept was the original CLI banner:
a four-line block/figlet rendering of `musterd` in mustard, mirrored into the Figma brand brief as the
frozen `wordmark/ascii-block` and named by [brand.md](../design/brand.md) §1 as the source of truth.

Seen next to the new grouped help, that block wordmark reads as dated — 1990s BBS ASCII art — against a
product whose web surface is a warm isometric office and whose CLI now aims for sleek and modern. It is
also large (five lines before any content) for a banner that leads every `help` and `serve`.

## Problem

Replace the CLI wordmark with something warm, modern, compact, and _meaningful_ — within the same hard
constraints [brand.md](../design/brand.md) fixes: 16-color ANSI (degrades cleanly), lowercase `musterd`,
one mustard accent, JetBrains-Mono feel, no gradients/3-D/stylized casing. And record it honestly,
since ADR 113 said the wordmark would not change.

## Decision

The CLI banner is a **roll-call lockup**: three presence dots — online (green ●), away (mustard ●),
offline (dim ○), the CLI's own `theme.presenceDot` glyphs — beside the **`musterd` brand chip** (the
lowercase word reversed out of a solid mustard block, `theme.brandmark`), with the tagline under it.

```
● ● ○  ▐ musterd ▌      ← “ musterd ” reversed out of a mustard block
muster your agents and humans into persistent teams
```

The enemy retired here is **multi-line letter-art** — the thin-outline figlet (`_ __ ___ | |_ …`) read
as 1990s BBS art, and a solid-block figlet, tried next, still read as "the same kind of thing" (big
letters spanning the banner). The chip sidesteps the whole category: it is a typographic logo lockup,
compact and bold, that does not draw the letters. The roll-call dots are the signature: `muster`
_means_ roll call — assembling the team, taking presence — and presence is the product, so the dots
(reusing the roster's own glyphs) show the thing itself, a team present.

Iteration note (same day): minimal one-line wordmark → too underweight; solid-block figlet → too close
to the original letter-art; landed on the reversed-out **chip** — present but not letter-art. Recorded
inline rather than as a churn of superseding ADRs.

Implemented in [`packages/cli/src/render/rows.ts`](../../packages/cli/src/render/rows.ts) `renderBanner`
— still the single source of truth. [brand.md](../design/brand.md) §1 is updated in the same change; the
two Figma briefs that froze the old thin-outline block carry a supersede note pointing here.

## Consequences

- The banner is warmer and smaller; `help`/`serve` lead with a live-feeling roster mark, not retro art.
- The Figma `wordmark/ascii-block` frame is now stale — a follow-up Figma sync should redraw the lockup
  (tracked by the supersede notes in the briefs). Reality (the CLI) still wins per brand.md §1.
- Fully reversible and within the existing brand: one accent, lowercase wordmark, no new glyphs beyond
  the presence dots already in use. No palette or dependency change.

## Observability & Evaluation

- **Traces:** n/a — a static wordmark string in `renderBanner`; no acts, spans, or data flow change.
- **Eval:** n/a — presentation, not a model-facing capability. The guardrail is the `renderBanner` unit
  test (`render/rows.test.ts`), which pins the roll-call shape (presence dots + wordmark + tagline, two
  lines) so the block art can't silently return.
- **Experiment:** n/a — no online experiment; the signal is qualitative (does the banner read as modern
  and warm rather than dated).
