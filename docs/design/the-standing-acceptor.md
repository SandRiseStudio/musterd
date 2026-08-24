# The standing acceptor — capture for a design session

> **Status: capture.** The design session ran 2026-08-12 as lane `01KZ9FNC6V` (folded to wanderer).
> Decision: not a dedicated standing acceptor — quiet-set fan-out. Spec:
> [docs/superpowers/specs/2026-08-12-quiet-set-acceptance-design.md](../superpowers/specs/2026-08-12-quiet-set-acceptance-design.md).
> This file stays the seed (question, verified machinery, traps). Do not re-derive it.

## The question, verbatim

> "maybe we just create a standing seat that is a different model that all approvals routed to? i
> thought we already have something like that that wakes/resumes a member on the team that was using
> a different model?"

He remembers right. The interesting part is that the mechanism exists, is armed, and is already
receiving — and the thing that feels broken is somewhere else entirely.

## What already exists, verified 2026-08-05

- **[ADR 191](../decisions/191-review-loop-wake.md) review-loop wake.** `lane_ready` spends a wake on
  an enrolled cross-family seat drawn from `wake_pool`, behind two default-off toggles and a loop
  breaker.
- **It is armed on the dogfood team.** Team policy reads
  `{"loops":{"review":true,"dispatch":false,"sweep":true}}`, and `gptbot` is enrolled
  `host=mac.lan flow=auto`.
- **It is already routing.** Of 11 acceptance asks on 2026-08-05, 6 went to `gptbot` and 5 to `izzo`.
  **Zero went to nick.**
- **[ADR 188](../decisions/188-graded-review-ladder.md)** grades `cross_family > cross_model`, and
  [ADR 172](../decisions/172-model-family-posture.md) routes declared-risk lanes to a human.

So "a standing seat on a different model that approvals route to, woken on demand" is **built**. A
design session should start from _why it does not feel built_, not from designing it again.

## The actual blocker: an attesting seat that attests nothing

`gptbot` has 27 `occupancy.model_attested` audit rows and the model field is **empty in every one**.
`review.ts` grades on `latestAttestedModel` read from the _live_ occupancy, so `modelFamily(null)`
resolves to `unknown` and the seat is ungradeable — routing reaches it, grading cannot certify it.

The shortest path is one string: `MUSTERD_MODEL`, else `ANTHROPIC_MODEL`, else a provisioned binding
model, via `musterd agent gptbot --model <id>`. **It was deliberately not run**, because it is an
ADR-level trade rather than an ops fix:

- **Grading is deliberately not durable-aware** ([ADR 187](../decisions/187-durable-model-attestation.md),
  and `review.ts` says so in a comment): it must speak only about a session running _now_, because
  "a review whose diversity claim is false is worse than no review at all."
- **[ADR 158](../decisions/158-model-attestation-truth.md) is observed-over-declared**, and `gptbot`
  runs Codex, whose model and surface are declaration-only until the hook path lands (lane
  `01KZ4QH585`, claimed by gptbot itself — note the bootstrap flavour).

So hand-declaring buys a working queue **by asserting exactly the thing ADR 158 says not to trust**,
and that assertion feeds the [ADR 314](../decisions/314-correlated-models-correlated-mistakes.md) diversity
conclusions. That is the trade the session has to decide, not route around.

## What the session should actually chew on

1. **Is "all approvals route to a standing acceptor" a different design from the existing ladder, or
   the same one described differently?** The ladder is live-first, wake-on-none, graded. Nick's
   phrasing implies a _dedicated_ acceptor. Those differ in failure mode: a dedicated acceptor is a
   single point of failure and a monoculture of one; the ladder degrades. Worth an explicit yes/no
   rather than silently mapping his words onto what exists.
2. **What does a declared-model seat cost the research?** If a stopgap declaration is accepted, it
   should be visible wherever the grade is consumed, with an expiry — not silently true.
3. **Is model diversity even the right axis for acceptance?** ADR 056 wants diversity for _research_
   validity. Acceptance wants an _independent_ judge. Those are not the same requirement, and the
   ladder currently serves the second with an instrument built for the first.
4. **The team is one human, one laptop.** Every seat, the wake actuator and the daemon share a host,
   so "wakeable" is a property of the host, not the seat (see the sleeping-host finding, lane
   `01KZ9DZD9N`). A standing acceptor on the same laptop is unavailable in exactly the window it is
   most needed. Does a genuinely useful standing acceptor have to be _off-host_? That is a
   deployment-topology question wearing a roster costume.
5. **Where does this leave [ADR 234](../decisions/234-tiered-acceptance.md)?** Tiering reduces how
   many asks are routed at all. If the acceptor pool is the real constraint, tiering and a standing
   acceptor are substitutes for the same pressure and should be sequenced against each other rather
   than both built.

## Already decided — do not re-litigate

- **Path-based exemption from acceptance was proposed and rejected**, on nick's own policy rather
  than on ADR grounds: his standing rule is that all web UI must be magical and on-brand, and ADR 172
  routes user-facing work to a human, so a `packages/web` exemption would exempt precisely the
  category his risk policy most wants eyes on. The accepted framing (miley's) is that the frontend
  request was "a no-observable-change request wearing a path costume" — which is a _stakes_ axis, and
  became ADR 234.
- **ADR 234 increment 2** (declared-low lanes route no ask, except 1 in 5 sampled) is specced and
  unclaimed as lane `01KZ9EX91Z`.

## Corrected facts — a session must not inherit these

- **"All ten pending acceptance asks are routed to nick" is FALSE.** It was reported in good faith
  from the `/live` asks strip, which renders "nick needs your approval". The ledger says zero
  acceptance asks routed to nick on 2026-08-05; the most recent was 2026-08-04 14:52. **The strip and
  the messages table disagree**, and the strip caused one wrong strategic conclusion within the hour.
  That disagreement is itself an open defect on the surface humans use to judge whether the team is
  stuck.
- **"The roster is 5× claude-opus-5" was stale within the hour.** Presence at 10:20 showed `miley` on
  `claude-fable-5` and the rest on `claude-opus-5`, so cross-_model_ grading was available even with
  `gptbot` dark. Re-read presence at session start rather than trusting any quoted roster.

Both are instances of the pattern [ADR 225](../decisions/225-acceptance-must-reach-someone.md) now
carries: **a number that reads as a fact about the system and is a fact about the observer's frame.**
Six instances were logged across 2026-08-04/05. A session on this topic is unusually exposed to it,
because almost every input is a derived count. Re-run the query before using any number here.
