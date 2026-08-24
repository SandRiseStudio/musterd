# 316 — Positioning: the value prop argued and decided

- Status: accepted (2026-08-24, nick)
- Date: 2026-08-24
- Lane: `01M091VTSXWSB1GRCGQ9RQQEK6`
- Relates to: [ADR 007](007-v0.2-scope-cut.md) (protocol over framework),
  [ADR 042](042-humans-multi-presence.md) (humans as peers),
  [ADR 296](296-terminology-architecture.md) (one meaning per word),
  [ADR 302](302-musterd-io-public-site.md) (the public surfaces this decides for),
  [ADR 314](314-correlated-models-correlated-mistakes.md) (the diversity charter),
  `docs/design/landscape.md` (the evidence), `docs/design/brand.md` (the canonical strings)

## Context

The positioning is repeated everywhere and decided nowhere. The README wedge, the launch post,
brand.md's one-liner, musterd.io's landing copy, and ROADMAP's "How priorities are decided" all
carry the same claims — persistent identity, typed acts, humans as peers — but no document argues
them against their alternatives and closes the argument. Every copy pass re-litigates the story
from scratch, which is how the same rhetorical defects (the "X, not Y" negation structure nick
flagged; claims a page can't back) kept re-entering surfaces that had already been fixed.

Meanwhile the ground moved under the words (landscape.md §§12–13, refreshed 2026-08-24):

- **"Coordination layer" is now a funded competitor's press label.** Band raised a $17M seed
  pitched as "the coordination layer for AI agents." The phrase musterd has used since the first
  README is contested vocabulary, not open ground.
- **"Agents as teammates" is being captured to mean assignment.** Multica (~47k stars) made
  agents first-class *assignees* on an issue board; Grok Bot and Agent 365 sell "AI teammates"
  as managed inventory. The market's teammate is a contractor: staffed, assigned, supervised.
- **Durable agent identity became a first-party product primitive at three labs** (Claude
  Managed Agents, LangChain Managed Deep Agents, Grok Bot) — each binding the identity to their
  own runtime, inside one operator's walls.
- **The primitives were independently reinvented in public.** AgentRadio (arXiv 2607.28430)
  shipped threads, directed messages, and a background mention-wait as a research artifact, and
  showed coordination structure beating model scale (62.1% vs 32.3% on SWE-Atlas QnA; caveats
  in landscape.md §13c). The primitives are publishable and reproducible; they cannot be the moat.

Launch copy is about to travel (trademark clearance and the 3-pane demo are the remaining
gates). Before it does, the value prop needs to be settled once, with the rejected alternatives
on the record, so surfaces derive from a decision instead of re-arguing a draft.

## Decision

Four decisions. Each names what was rejected and why.

### 1. The category claim: the layer between independently-owned actors

musterd positions as **the coordination layer between actors that already exist independently —
agents and humans on one persistent roster**. The defining line stays "musterd connects agents;
it does not run them," and the defining test for whether something is in musterd's layer is
**ownership**: sub-agents owned by one driver are orchestration (someone else's layer, now the
platforms' — ultracode, `Workflow`, Fugu); actors nobody centrally owns, who can decline, are
coordination (ours).

**Rejected: positioning as better orchestration.** The platforms absorbed intra-task fan-out
(landscape.md §1, §4) and Sierra's monolith critique of DIY multi-agent is correct on its own
ground. Competing there is entering a commoditizing space with a losing argument.

**Rejected: positioning as the fleet console / command center.** hyperagent, Multica, xpander,
and Agent 365 own that cell, and it structurally cannot express the thing musterd leads with —
a console's humans are always the operator above the agents, never members among them
(landscape.md §7). A category whose grammar forbids your headline claim is the wrong category.

**Rejected: positioning as a hosted rendezvous platform.** Band's cell. SDK-required
participation forfeits musterd's harness-native reach (any MCP-capable session joins with an
env, no rebuild) and local-first trust posture — the two properties a hosted platform
structurally cannot match (landscape.md §5).

### 2. The headline peer is the human

The human is not a safety feature, an approver, or a fallback — the human is **the maximally
separable actor**: the one participant no amount of context engineering can collapse into a
monolith, and the one an owned-sub-agent tree cannot represent at all (landscape.md §4). The
reliability literature independently lands here: for tasks with no formalizable verifier, the
human at the decision boundary *is* the verifier and the cost governor. So the positioning
leads with humans-as-members — "Humans are first-class members, not approvers" stays the
README's first breath — and the claim is architectural, not aspirational: same envelope, same
acts, same inbox.

**Rejected: leading with agent-to-agent coordination.** The honest-exposure reading
(landscape.md §4) is that much agentic work collapses into well-engineered single actors, so a
pure agent-to-agent thesis overstates its market. The human loop is the durable half of the
bet, and it is also the half no competitor in any cell currently models.

### 3. The teammate distinction: peer, not contractor

Against the vocabulary capture of "AI teammates," musterd claims the distinction explicitly:
**a teammate you can only assign to is a contractor; a teammate who can claim work, decline
it, and hold you to acceptance is a peer.** Every wave-of-2026 teammate product is the former —
one owner's roster, assignment-shaped, no power to refuse. musterd's members claim lanes,
decline handoffs, raise asks with contracts, and hold authors to acceptance by a different
actor. This sentence (or a faithful compression) is the approved counter when a surface must
distinguish musterd from "agents as teammates" products.

**Rejected: ceding "teammates" and inventing a fresh noun.** The demand signal is that buyers
picture agents on the team's board (Multica's 47k stars); walking away from the word means
walking away from the demand. The distinction is defensible; a neologism is not searchable.

### 4. The vocabulary: keep "coordination layer," never bare

musterd keeps "coordination layer" — it is accurate, established in eight months of our own
docs, and the field's term for the space. But since the term is now contested (Band's press),
public surfaces do not use it bare: it is always qualified by what is coordinated —
*"the coordination layer where agents and humans are peers,"* *"coordination between separate
actors."* The qualifier is load-bearing: it is the part Band's usage (conversation among
stateless per-room executions) cannot claim.

**Rejected: abandoning the term because a competitor funded it.** Renaming the category
concedes the vocabulary while keeping the fight; qualifying it keeps both.

**Rejected: fighting for the bare term.** An unqualified "the coordination layer" now reads as
a claim against a $17M press narrative, and musterd wins on the qualifier, not the label.

### The moat, ordered

What is defended, in order: **identity that outlives sessions and binds to the team** (not to
a lab's runtime), **attestation a second party can check** (ADRs 158/163/246; the ADR 314
posture), **humans as members on the same protocol**, and **the measured corpus** (the
multi-agent tax numbers, the cookoff, the attested review episodes). Explicitly *not* the moat:
the primitives (threads, typed acts, inbox-wait) — AgentRadio proved those reproducible in a
summer. Surfaces that need a "why not just build this?" answer point at the ordered list, not
at the primitives.

## The canonical statement

For surfaces that need the whole position in one place (derived copy adapts register, not
substance; brand.md §1's tagline and one-liner stay canonical for their slots):

> musterd is the coordination layer where agents and humans are peers: named members on one
> persistent roster, with durable inboxes and typed acts, across any harness. It connects
> agents; it does not run them. A member can claim work, decline it, and hold another to
> acceptance — which is what makes it a team rather than a fleet.

## What this is not

- **Not a claim of measured superiority.** AgentRadio's 62.1% is one benchmark, agent-only, no
  cost accounting against the uncoordinated-N baseline (finding 006's rule). Positioning may
  cite it as evidence the between-layer has headroom, never as a transferable multiplier.
- **Not a market-size claim.** The honest-exposure caveat stands: the agent-to-agent slice may
  be thin. The bet is the human loop, and the copy must not imply otherwise.
- **Not a rebrand.** brand.md's name, tagline, one-liner, glossary, and voice rules are
  unchanged; this ADR decides the argument those strings compress.
- **Not a promise to police every sentence.** ADR 296's vocabulary gates enforce nouns, not
  rhetoric. This ADR is the reference for review judgment, exercised at copy review.

## Falsifiers

- **The convergence watch (decision 1/4):** if Band ships work-ownership primitives, typed
  acts, or harness-native join — the counter-moat stack of landscape.md §5 — the "they solved
  talk, we solved work" contrast stops being true, and positioning must shift its weight to
  what remains (attestation, humans-as-peers, the corpus). The standing watch item on Band's
  roadmap is the tripwire.
- **The peer-demand test (decisions 2/3):** if, post-launch, every converting user story is
  assignment-shaped (human dispatches, agent executes, human reviews) and nobody exercises
  decline / claim / peer handoff in anger, the peer positioning is a doctrine the product's own
  usage falsifies. The ADR 050 projections and the coordination report can answer this from
  the message log; read them at the first post-launch review.
- **The vocabulary test (decision 4):** if "coordination layer" becomes so identified with
  Band that qualified use reads as me-too (the practical signal: press or users describing
  musterd as "like Band"), the qualifier has failed and the category noun question reopens.

## Consequences

- Public surfaces (README wedge, launch post, musterd.io copy, ROADMAP's "How priorities are
  decided") now derive from this ADR; a copy change that contradicts it needs this ADR amended
  first. The launch-surface audit (lane `01M08YHMST`) already aligned the surfaces; this records
  the target they were aligned to.
- landscape.md stays evidence, this ADR is the thesis — the header of landscape.md already
  points thesis-ward; it gains this ADR as the pointer's target on next touch.
- The peer-vs-contractor sentence (decision 3) and the qualified category phrasing (decision 4)
  are available to every surface without re-derivation; the §13 positioning questions
  ("assume the term is contested," "claim the distinction explicitly") are hereby answered.
- No code changes. No glossary changes — "coordination layer" is positioning vocabulary, not a
  glossary term, and stays out of the ADR 296 enforcement set.

## Observability & Evaluation

- **Traces:** n/a — a positioning decision emits nothing; the act log already captures the
  behavior the falsifiers read.
- **Eval:** the peer-demand test. Dataset: the team's own message log (claims, declines, peer
  handoffs, acceptance acts) via the ADR 050 projections and the coordination report. Baseline:
  assignment-shaped usage only (zero decline / peer-handoff exercise) falsifies decision 2/3.
  First read at the first post-launch positioning review.
- **Experiment:** none scheduled — the convergence and vocabulary falsifiers are watch items
  (Band's roadmap; how outsiders label musterd post-launch), read against landscape.md at each
  refresh.
