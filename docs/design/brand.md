# musterd — Brand Source of Truth

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

This file is the single source of truth from which all three Figma briefs and all CLI/README visual choices derive. If a brief and this file disagree, this file wins — fix the brief (with an ADR if the change is substantive).

---

## 1. Name & wordmark

- **Name:** `musterd` — always lowercase, even at the start of a sentence in body copy where possible. In headings it may be capitalized (`Musterd`) only when typographic convention forces it; prefer lowercase.
- **Etymology / story (for voice, not for repetition):** *muster* ("assemble the team", "roll call" = presence) + the `-d` daemon suffix, with a deliberate mustard pun for warmth. Do not over-explain the pun in product copy; one wink in the README is enough.
- **Tagline (canonical):** *"Muster your agents and humans into persistent teams."*
- **One-liner (canonical):** *"Named, persistent teams of agents and humans — across any harness, framework, model, or surface — with a shared communication protocol."*

### Wordmark rules

- **ASCII wordmark** (CLI banner + README header): the literal lowercase string `musterd`. A block/ANSI-shaded version is allowed for the CLI banner; the canonical block form is generated and frozen in `figma-brief-brand.md` and mirrored as a string constant in `packages/cli`.
- **Vector wordmark** (Figma): lowercase `musterd` set in the brand mono typeface (see §3), letter-spacing `0`, single accent dot or the `-d` rendered in accent mustard is the only permitted flourish.
- **Never:** stylized "MusterD", camel case, a separate icon glyph that isn't derived from the letterforms, gradients, drop shadows, or 3-D treatments.

---

## 2. Color

Single accent philosophy: **one mustard accent** carries the entire identity right now. Everything else is neutral zinc. This is deliberately minimal and fully reversible.

### Accent — Mustard ramp

| Token            | Hex       | Use |
|------------------|-----------|-----|
| `mustard-50`     | `#FBF3D5` | faint tint backgrounds (web) |
| `mustard-100`    | `#F6E4A8` | hover tint |
| `mustard-300`    | `#EFC94C` | secondary accent / highlights |
| `mustard-500`    | `#E1AD01` | **primary accent** (canonical mustard) |
| `mustard-700`    | `#B8860B` | accent pressed / dark-mode accent text |
| `mustard-900`    | `#7A5A06` | accent on light, high-contrast text |

Primary accent is **`#E1AD01`**. When a single color value is needed (badge, link, banner), use this.

### Neutrals — Zinc ramp

| Token        | Hex       | Use |
|--------------|-----------|-----|
| `zinc-50`    | `#FAFAFA` | web light bg |
| `zinc-100`   | `#F4F4F5` | light surface |
| `zinc-200`   | `#E4E4E7` | borders (light) |
| `zinc-400`   | `#A1A1AA` | muted text |
| `zinc-500`   | `#71717A` | secondary text |
| `zinc-700`   | `#3F3F46` | borders (dark) |
| `zinc-800`   | `#27272A` | dark surface |
| `zinc-900`   | `#18181B` | dark bg / terminal bg |
| `zinc-950`   | `#09090B` | deepest bg |

### Semantic (web dashboard + ANSI mapping)

| Meaning   | Light hex | Dark hex  | ANSI (terminal) |
|-----------|-----------|-----------|-----------------|
| success   | `#15803D` | `#22C55E` | green |
| warning   | `#B45309` | `#F59E0B` | yellow |
| danger    | `#B91C1C` | `#EF4444` | red |
| info      | `#1D4ED8` | `#60A5FA` | blue |
| accent    | `#E1AD01` | `#EFC94C` | yellow (bold) |
| muted     | `#71717A` | `#A1A1AA` | bright black |

### ANSI color mapping (terminal — load-bearing, the CLI must obey)

The CLI uses only these mappings so output stays on-brand and degrades cleanly in 16-color terminals:

- **accent / brand** → bold yellow
- **member name (agent)** → cyan
- **member name (human)** → magenta
- **presence: online** → green dot `●`
- **presence: away** → yellow dot `●`
- **presence: offline** → bright-black dot `○`
- **act badges** → see §5 glossary; rendered as `[act]` in dim white, except `request_help` (bold yellow) and `decline` (red)
- **timestamps / metadata** → bright black (dim)
- **errors** → red; **warnings** → yellow; **success confirmations** → green

---

## 3. Typography

Two families only.

- **Mono (terminal, code, wordmark, CLI-mirroring UI):** `JetBrains Mono` as the design/Figma reference. In the README/web, the CSS stack is `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace`. The CLI inherits the user's terminal font — Figma terminal frames must use a mono that visually matches an 80-col terminal grid.
- **Sans (docs, web dashboard chrome, marketing):** `Inter`. CSS stack `Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`.

### Type ramp (web/docs)

| Token     | Size / line-height | Weight | Family |
|-----------|--------------------|--------|--------|
| display   | 40 / 48            | 700    | Inter  |
| h1        | 28 / 36            | 700    | Inter  |
| h2        | 22 / 30            | 600    | Inter  |
| h3        | 18 / 26            | 600    | Inter  |
| body      | 15 / 24            | 400    | Inter  |
| small     | 13 / 20            | 400    | Inter  |
| mono-body | 14 / 22            | 400    | JetBrains Mono |
| mono-sm   | 12 / 18            | 400    | JetBrains Mono |

### Terminal type ramp (Figma terminal frames)

Single mono size at `14 / 22`; bold for emphasis; never italic in terminal frames (terminals render it inconsistently).

---

## 4. Voice & tone

- **Plain, declarative, no hype.** No "revolutionary", "magic", "supercharge", "10x". State what it does.
- **Second person, present tense** in docs ("you create a team", not "users can create teams").
- **Lowercase product name**, sentence-case headings.
- **Respect the reader's intelligence.** Short sentences. One idea per sentence. Lead with the concrete.
- **Honest about scope.** When something is roadmap, say "not yet" plainly — never imply it exists.
- The single allowed bit of personality: one mustard pun in the README, and warm-but-spare microcopy in the CLI (e.g. empty inbox: `inbox empty — nobody's mustered anything yet`).

---

## 5. Terminology glossary (canonical — used identically in SPEC, CLI, docs, UI)

These five terms are load-bearing. They must appear with these exact meanings everywhere — code identifiers, CLI help text, doc prose, Figma labels. Do not introduce synonyms.

| Term         | Definition | Not |
|--------------|------------|-----|
| **Team**     | A named, persistent group of Members with shared messaging — a **standing roster**, not a project. It outlives any task, session, *or repository*: the same Team is reused across folders to keep the same agents talking. The folder only decides *where* a given Member runs (the folder→agent binding); the Team is the durable, cross-project roster. | not "room", "channel", "swarm", "project" |
| **Member**   | A durable identity in a Team. `kind: agent \| human`. Has a name, role (free text), lifecycle, availability. A Member is **not** a session. | not "agent", "user", "participant" |
| **Presence** | Where a Member is currently attached (a Claude Code session, a Codex session, a CLI, later an app). One Member can have multiple Presences. | not "session", "connection", "status" |
| **Surface**  | A kind of place a Member can be present: `cli`, `claude-code`, `codex`, (later) `ios`, `web`, `slack`. A Surface hosts a Presence. | not "client", "platform", "adapter" (adapter is the code; Surface is the concept) |
| **Act**      | The typed intent of a message: `message`, `status_update`, `request_help`, `handoff`, `accept`, `decline`, `wait`, `resolve`. Grounded in the Co-Gym collaboration-act taxonomy. | not "type", "kind", "event", "verb" |

Secondary nouns (consistent but not in the core five): **Inbox** (a Member's durable mailbox for messages received while offline), **Envelope** (the on-wire message structure), **Roster** (a Team's list of Members), **Lifecycle** (`forever | session | until <ts>`), **Availability** (a Member's schedule; v1 stores it, does not enforce it).

---

## 6. Reversibility note

This entire identity is intentionally small: one name, one accent color, one wordmark, five terms, two typefaces, plain voice. Every choice here can be walked back without code changes beyond a palette constant and a banner string. Do not expand the brand (logos, mascots, multi-color systems, illustration) without an ADR and an explicit decision to invest.

## 7. Web surface (carve-out)

The **landing / marketing web surface** (`packages/web`) is allowed to go maximal — immersive WebGL, gradients, glows, depth, motion, and a deep-black ground — while the **product chrome** (CLI, terminal frames, the future dashboard's functional UI) stays minimal under §1–§6. The shared anchor is unchanged on every surface: mustard `#E1AD01` is still the one accent, Inter + JetBrains Mono are still the only typefaces, the wordmark is still lowercase JetBrains Mono, and copy stays plain and declarative (the *experience* carries the spectacle, never the words). This split, its guardrails (reduced-motion fallback, static-first content), and its limits are recorded in `docs/decisions/037-web-surface-aesthetic.md`.
