# Brand brainstorm — coordination observability as a standalone product

> **Brainstorm brief, not a brand decision.** Per `brand.md` §6, expanding the brand (a second product name included) requires an ADR and an explicit decision to invest. This doc collects the thinking so that decision is easy when the product (observability design §5) is real. Status: **open brainstorm**, updated 2026-06-11.

## 1. What we're naming

A coordination-observability product: it shows what happens *between* agents and humans — handoffs, help requests, waits, ignored messages, MAST-class coordination failures — as derived views over an act-typed message log, linked to per-agent traces via OTel context (ADR 011).

Positioning constraints from the design doc:

- **Native to musterd, not captive to it.** Ingests musterd logs first-class, but also plain OTel GenAI/agent spans — usable by teams that don't run musterd at all.
- **Completes the existing market, doesn't fight it.** It sits beside Langfuse/Braintrust/Datadog, not instead of them.
- **Diagnostic, not evaluative.** Never a leaderboard of Members (human-agent-dynamics §4).

## 2. Where it sits in the ecosystem

Three possible brand strategies:

| Strategy | Example | For | Against |
|----------|---------|-----|---------|
| **a. Feature sub-brand** | "musterd insights", `@musterd/insights` | Zero new brand cost; inherits trust | Caps the standalone ambition — "musterd X" reads as requiring musterd; weakest position for non-musterd users |
| **b. Sibling brand in the family** | own name, shared design system, "from the makers of musterd" | Standalone credibility *and* ecosystem halo; name can carry its own metaphor | One more name to defend (npm, domain, trademark) |
| **c. Fully independent brand** | own name, own identity | Maximum independence | Throws away the ecosystem story for no gain at this stage |

**Recommendation: (b) sibling brand.** Same minimal design system as musterd (zinc neutrals, mono wordmark, plain voice), its own name and its own accent color, explicitly part of the family in copy.

### amprealize

Context (recorded 2026-06-11): amprealize was a prior project — an agile project tools / behavior engine / AI agent platform (`/Users/nick/main`) that grew over-engineered and never fully shipped. The `amprealize.ai` domain is owned. Current thinking: possibly repurpose amprealize as a parent-company / umbrella brand over musterd and this product — but **do not force an ecosystem into existence**. The decision rule: the umbrella appears only when there are two shipped products that genuinely need a shared roof; until then musterd (and later this product) stand on their own names, and amprealize stays a held domain, not a public story. The old amprealize codebase is a cautionary tale this repo's principles already answer (deliberately small, protocol over framework) — the name can be reused; the architecture should not be.

## 3. Naming criteria

Inherited from musterd's brand rules plus the product's nature:

1. Lowercase, mono-typeface-friendly, works as a CLI/bin name.
2. Carries standalone meaning — a non-musterd user should get it without the backstory.
3. An ecosystem wink (muster/military or mustard/botany family) is a plus, never a requirement.
4. Available: unscoped npm name, a sane domain, no obvious trademark collision in dev tools.
5. No hype words, no "AI" in the name (dates instantly).

## 4. Candidates

Availability checked 2026-06-11. npm = unscoped package name; domains via whois (.dev via DNS only — verify at a registrar before relying on it). ✅ free, ❌ taken, — not checked.

Priority shift (2026-06-11): npm-free is now a **hard filter**, and the name must read as **plain English Nick already feels** — sinapsed was liked but "synapse" is too obscure to feel like his own voice. Re-weighted toward concrete, picture-able words.

### Shortlist (npm free)

| Name | npm | .com | .ai | .dev | Metaphor / rationale | Concerns |
|------|-----|------|-----|------|----------------------|----------|
| **batond** | ✅ | ❌ parked | ✅ | ✅ | The relay **baton** + the musterd `-d` daemon suffix → visibly a sibling of musterd. Maximally plain: a physical object handed off mid-stride = a `handoff`. A **dropped baton** is exactly the coordination failure the product surfaces. No explanation needed. | `.com` registered (parked at Gname since 2017, buyable). `.ai`/`.dev` free — fine for a dev tool, and Nick already owns amprealize.ai |
| **throughd** | ✅ | ✅ | ✅ | ✅ | "The throughline" through a coordination — all domains free. | Awkward to say; reads like a typo of "through'd"; weakest as a word |
| **sinapsed** | ✅ | ✅ | ✅ | likely ✅ | *Sinapis* (mustard genus) × *synapse* × `-d`. The richest metaphor. | **Nick's objection:** "synapse" is too obscure to feel like him. Kept as runner-up only |
| **tetherd** | ✅ | ❌ | ❌ | likely ✅ | A tether = the line connecting two things; plain and tangible. | only `.dev` open |
| **stitchd** | ✅ | ❌ | ❌ | ❌ | Stitching threads together (musterd has threads). | domains gone |

### Bench (npm free, weaker)

- **charlock** (✅) — wild mustard, grows *between* the crops; .ai free, .dev taken. Obscure word.
- **loomd** (✅) — weaves threads / "looms over"; Loom-Atlassian adjacency.
- **observd** (✅) — plain but generic, zero metaphor, hard to defend.
- **debriefd** (✅) — after-action review; Nick: "okay/kind of good." `-d` implies a daemon it isn't.
- **standto / standby-d** (✅) — military muster terms (stand-to = dawn muster); need explaining.
- **sarson / kasundi** (✅) — mustard in Hindi / Bengali; warm but opaque.

### Ruled out

- **sentryd** — npm free, but Sentry owns observability; instant confusion. Dead on arrival.
- **relayd** — npm free, but collides with OpenBSD's `relayd` daemon.
- **rollcall** — npm free, but Nick doesn't like it.
- **sinapse, crosstalk, weft, baton, relay, tether, stitch, sentry, weave, conduit, plexus** — npm taken.
- **fieldglass** — npm free but SAP Fieldglass owns the space.
- **tracelink** — npm free but TraceLink Inc. (supply-chain SaaS) owns it.
- **musterroll, musterglass** — read as musterd features, not a standalone tool (strategy a, not b).

## 5. Decision — working name: `batond` (reversible)

**Chosen 2026-06-11: `batond`** as the working name for the coordination-observability product. It answers Nick's exact objection to sinapsed: nothing to look up. A baton is a thing you can picture, the relay handoff is the most intuitive possible image for inter-agent coordination, and the `-d` makes it an unmistakable sibling of musterd. npm free; `.ai` and `.dev` free; only `.com` is parked (buyable, and `.ai`/`.dev` is the better primary for an AI-era dev tool anyway). Bonus: the failure metaphor (a *dropped* baton) is built in — apt for a tool that surfaces coordination breakdowns.

**Reversibility (per brand.md §6).** This is a held working name, not a brand commitment. Until there is shipped code, "batond" lives only in docs as the label for the product thesis — it is **not** baked into package names, identifiers, or public copy. No brand identity (accent color, wordmark, domain purchase, npm publish) is created until a build decision is made. Walking the name back at this stage costs a find-and-replace across a handful of design docs. Runner-up if batond fails a later trademark check: **sinapsed** (richest metaphor, all domains free); then **throughd** (all domains free, weakest as a word).

Tagline sketches (batond):

- *"Don't drop the baton."*
- *"Observability for the handoff."*
- *"See the space between your agents — every handoff, wait, and dropped ball."*

Visual identity: inherit the musterd system wholesale (zinc, JetBrains Mono wordmark, plain voice); pick one accent that is **not** mustard-500 so the siblings are distinguishable side by side — decide only when the product is real, per brand.md's reversibility principle.

## 6. Open questions / next steps

1. **batond** is the working name (§5). Low-cost, reversible reservation steps when Nick gives the go-ahead — none done yet, all cost money or are outward-facing: quick trademark sanity-check in dev-tools/software classes; reserve the npm name (`npm-reserve/` placeholder, same pattern as ADR 009); register batond.ai / batond.dev (whois/DNS checks here are point-in-time, not authoritative — verify at a registrar).
3. amprealize: leave as a held domain for now (§2 decision rule); revisit the umbrella question only when a second product actually ships.
4. Write the brand ADR (per brand.md §6) only when the product gets a build commitment — a reserved name costs nothing; a second brand identity does.
