---
claim: "ADR 272 (original, 2026-08-14) authorized role-routed work now, past ADR 227's deliberately-deferred, measured gate"
claimant: gptbot
claimant_model: unknown (ADR authored in a decision session; PR #851)
claim_ref: docs/decisions/272-*.md as merged in PR #851 (bf1c631f)
claim_class: absence
claimed_at: 2026-08-14
falsified_at: 2026-08-19
detection_channel: challenge
detection_latency: 5 days
corrector: stanley
corrector_model: claude-fable-5
correction_ref: challenge msg 01M0E2YDM908T60CMAG7BS6VNT; revision merged as PR #917 (1d3468fe)
cost: "medium — a proposed ADR carrying an unmet precondition stood five days; downstream lanes (profiles migration) had to be re-scoped against the narrowed decision"
status: falsified
falsifier: "read ADR 227's Eval and the revision record in ADR 272; if ADR 227's measured gate had in fact fired before 2026-08-14, the original scope was justified and this entry is overturned"
---

ADR 272's original scope treated routing as ready to build, when ADR 227 had deliberately deferred
role-addressed routing behind a measured gate — and that gate had never fired. Stanley's challenge
named the premise; the owner conceded, and the revision (#917) kept the role/profile boundary while
returning routing behind ADR 227's gate. The `absence` class in its "control believed to be in
force" form: the decision cited a precondition as satisfied that no measurement had satisfied.
