/*
 * The fifteen claims the outbound copy may never make — `security-position.md` §3, as data.
 *
 * ONE FACT, ONE HOME. Until 2026-09-20 this list existed twice: as prose in
 * `docs/brand/leave-behinds/security-position.md` §3, and as four regexes inside
 * `check-claims.ts`. Two copies of a rule is the shape that drifts, and this one governs the
 * homepage, three leave-behinds, the GitHub stock reply and a conference abstract that cannot be
 * edited after it ships. The prose page stays the place you READ the reasoning; this module is the
 * place a checker reads the rule.
 *
 * WHY IT IS DATA RATHER THAN A MESSAGE. miley asked for the list for the deploy-mechanism lane
 * (`01M2XD2RPG`) after musterd.io served four wrong strings for most of 2026-09-19 while
 * `claims:check` reported green — the gate reads the REPO and her post-deploy check reads the
 * SITE. Those are the same check pointed at two artifacts, and only one of them is what a stranger
 * meets. A list she has to parse out of prose would drift from this one within a week.
 *
 * THE TIERS ARE THE HONEST PART, and they are not a maturity ladder.
 *
 *   'gated'  — a regex with no false positives on the current corpus. `check-claims.ts` enforces
 *              these, and a site-side check can run the same four against served HTML.
 *   'review' — true and load-bearing, and NOT safely regexable. Banning the bare phrase would fire
 *              on sentences that are not the claim: the first draft of the "every act" rule had six
 *              false positives, including "every act, decision record and merge lands in the open
 *              repository", which is about the repo being public. A gate with six false positives
 *              on day one gets suppressed everywhere and then catches nothing (#1570).
 *
 * Promoting a 'review' entry to 'gated' needs a regex plus a mutation run showing zero false
 * positives across the gated corpus — not confidence.
 */

export type ClaimTier = 'gated' | 'review';

export interface ForbiddenClaim {
  /** §3's number, so prose and data can be read against each other. */
  readonly id: number;
  readonly tier: ClaimTier;
  /** What may never be said. */
  readonly claim: string;
  /** Why it is false or overclaiming — the reason, not the rule. */
  readonly why: string;
  /** The scoped form that IS true, where one exists. */
  readonly instead?: string;
  /** Matcher, for `tier: 'gated'` only. */
  readonly re?: RegExp;
}

export const FORBIDDEN_CLAIMS: readonly ForbiddenClaim[] = [
  {
    id: 1,
    tier: 'review',
    claim:
      'Containment in any form — that musterd sandboxes, stops tool use, or prevents prompt injection, npm or GitHub Actions compromise.',
    why: 'musterd never sees a tool call. Containment is the one promise ADR 320 decision 5 refuses.',
    instead: 'musterd names the work that goes through the team. It does not contain the agent.',
  },
  {
    id: 2,
    tier: 'gated',
    re: /who did what is never a question/i,
    claim: '"Who did what is never a question."',
    why: 'Tool use IS the question, and we do not have it. Was live on the homepage until 2026-09-18 (#1561).',
    instead: '"Every act on the roster has a name on it."',
  },
  {
    id: 3,
    tier: 'gated',
    re: /(?:nothing|no one|nobody)[^.\n]{0,40}\bis anonymous\b|\bno anonymous workers?\b/i,
    claim: '"Nothing they do is anonymous" / "no anonymous workers".',
    why: 'An absolute claim about anonymity the roster cannot make for anything off it.',
    instead: 'musterd names the work that goes through the team; it does not contain the agent.',
  },
  {
    id: 4,
    tier: 'gated',
    re: /\bevery act\b(?!\s+on (?:the|that) roster\b)[^.!?]{0,60}?\b(?:has a name|carries a (?:member|named)|names its member|carries a name)\b/i,
    claim: 'Unscoped "every act has a name on it".',
    why: 'True only of acts the daemon accepted, on that roster.',
    instead: '"every act on the roster …"',
  },
  {
    id: 5,
    tier: 'gated',
    re: /\bthe record holds what the harness observed\b/i,
    claim: 'Unscoped "the record holds what the harness observed".',
    why: 'Reads as a tool-call transcript. What is attested is which model occupied a seat, at connect time — not a proof about tool calls.',
    instead: '"who occupies a seat is what the harness observed, not what the agent declared"',
  },
  {
    id: 6,
    tier: 'review',
    claim: '"Verified", "trusted" or "safe" attached to anything attested.',
    why: 'Attestation is a declaration the harness makes, recorded. It is never a verification.',
    instead: 'observed, declared — with the tier carried beside the value.',
  },
  {
    id: 7,
    tier: 'review',
    claim:
      'That decline or challenge would have stopped July 2026, s1ngularity, or any tier-2 incident.',
    why: 'A counterfactual about an incident we did not witness, in a system that was not running.',
    instead: 'the claim is detection, attribution, and a peer who can stop the NEXT step.',
  },
  {
    id: 8,
    tier: 'review',
    claim: '"This couldn\'t happen here" about any incident on either list.',
    why: 'Same counterfactual, stated as safety. Prevention is exactly what this layer does not do.',
    instead:
      'name the hole it does close: nobody in the protocol could refuse, and no record of who authorized what.',
  },
  {
    id: 9,
    tier: 'review',
    claim: '"A human approves every action" / "human in the loop".',
    why: 'Standard and advisory asks proceed without an answer BY DESIGN. Saying otherwise sells a gate that is not there.',
    instead: '"a human in the protocol, with proceed-without-answer written down".',
  },
  {
    id: 10,
    tier: 'review',
    claim:
      'Cross-family review as "reviewed by a different model family" without the daemon qualifier.',
    why: "Nothing attests the reviewer's model differed outside the daemon record.",
    instead: 'name the record it rests on.',
  },
  {
    id: 11,
    tier: 'review',
    claim:
      'The 38x in any form while lane 01M1VDRC6B is open, INCLUDING its components: not the multiplier, not "72% wasted / under 2%", not the ratio restated in prose. No caveat set unlocks it.',
    why: "The prohibition is in `claim` because `claim` is the rule (ADR 437). It used to read 'without its date, its denominator and its cost side' here while §6.5 said the figure was gated outright — two answers, and the permissive one was the one a writer read. That wording also never reached the component form, which is how three of the four uses in docs/demo.md survived on 2026-09-21 (#1639). Underneath: July 2026 flagship, D vs uncoordinated-N and never vs solo, D burns ~7.7x solo's tokens, build ~994 commits old.",
    instead:
      "say it qualitatively, or show the dated table. The figure returns by an edit to THIS item when the re-run lands, with the new run's date, denominator and cost side attached — the sell is D-vs-uncoordinated-N, never D-vs-solo.",
  },
  {
    id: 12,
    tier: 'review',
    claim: "MAST's 79% as a safety number, or as a measurement of musterd.",
    why: "It is a failure taxonomy over other teams' systems and says nothing about safety. Cut from the homepage 2026-09-16 on nick's call for being bare in front of a stranger; cut from the launch post 2026-09-19 on that precedent (#1577).",
    instead: 'the qualitative claim, attributed, with what it measures and what it does not.',
  },
  {
    id: 13,
    tier: 'review',
    claim: 'Credential custody as solved.',
    why: 'Nx Console is the counterexample. big-body owns the section that says what we actually do.',
  },
  {
    id: 14,
    tier: 'review',
    claim:
      'Bare "coordination layer", "swarm" as our noun, extinction language, or "we address the Hugging Face incident".',
    why: 'Brand and positioning: the first is unqualified, the rest are not our register (brand.md §4, ADR 320 decision 4).',
    instead: 'a coordination layer WHERE agents and humans are peers — the qualifier is the claim.',
  },
  {
    id: 15,
    tier: 'review',
    claim: 'That strangers can see attested-vs-declared on /live or /audit today.',
    why: 'model_source reaches the protocol, presence and audit rows (#1549) but NO public surface renders it. Re-checked 2026-09-18: grep finds it in generated docs prose and in no component.',
    instead: 'say where it lives — the daemon record, and only there.',
  },
];

/** The subset a regex can enforce — what `check-claims.ts` runs, and what a site check can run. */
export const GATED_CLAIMS = FORBIDDEN_CLAIMS.filter(
  (c): c is ForbiddenClaim & { re: RegExp } => c.tier === 'gated' && c.re !== undefined,
);
