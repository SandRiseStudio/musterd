# 184 — The dataset gate: consent and redaction as a posture of their own

- Status: accepted (2026-07-31) — §The one decision answered **no** (structural-only v1; see Amendment).
- Date: 2026-07-30
- Authored by izzo (lane `01KYRNHVWNKXR0M9PHGREJDN6S`), at nick's direction.
- Accepted by: nick + ryder (flywheel reevaluation; design
  `docs/superpowers/specs/2026-07-31-flywheel-reevaluation-design.md`).
- Number **184** — verified free on `origin/main` (highest is 183) at branch time.
- Extracted from: [ADR 051](051-trace-eval-experiment-flywheel.md), whose Consequences already say the
  named seams each get "its own ADR when built". This is that ADR for one of them, so it is a
  completion of 051's own instruction rather than a departure from it.
- Builds on: [ADR 040](040-secured-off-loopback-bind.md) (the off-loopback posture),
  `docs/design/observability.md` §4 (the "never the body" trace stance),
  [ADR 167](167-harness-native-session-messaging.md) (the daemon composes a line from structured fields,
  never the act body), [ADR 128](128-recipient-scoped-message-reads.md) (message bodies are
  recipient-scoped on read — the access boundary a publication would step outside of),
  [ADR 052](052-traces-evals-first-class-gate.md) (the definition-of-done gate this one borrows its
  shape from).

## Context

`docs/research/README.md` gates musterd's first research artifact — an open, redacted
coordination-traces dataset — like this:

> Release is **gated on the opt-in + redaction posture** (ADR 051) being enforced — no dataset ships
> before consent/redaction is real.

That gate has never opened, and an audit on 2026-07-30 found three reasons, in increasing order of
importance.

**1. The posture it cites is two lines long.** ADR 051 mentions consent/redaction in a single bullet:
prompts in traces are "opt-in and versioned", content capture is "opt-in with redaction + retention
policy". That is a direction, not a contract. Nothing states what a compliant export looks like, so
"enforced" has no test.

**2. It lives in an ADR that is still `proposed`,** untouched since 2026-07-01, and 051 is a sweeping
product-boundary decision (what belongs in musterd core vs batond). It is hard to accept for reasons
that have nothing to do with dataset ethics — so the dataset waits on a debate it is not part of.
Meanwhile eight findings shipped and the practice ran anyway, which is the worst state for a decision
record: the ADR describes something that already happened.

**3. And the citation points at the wrong surface.** This is the finding that matters. ADR 051's
posture is about **prompt text inside spans**. The dataset is built from the **message log**. Those are
different bodies of data with different exposure, and calling both "the redaction posture" hid it:

| surface             | what it holds                                                            | posture today                                                                             |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Spans / traces      | models, tools, who-did-what; prompt by hash + version                    | **enforced** — never the body (observability.md §4); ADR 051                              |
| Audit `detail`      | shapes only; Bash commands as a fingerprint, never text (ADR 051)        | **enforced**                                                                              |
| The nudge rail      | a doorbell composed from structured fields, never the act body (ADR 167) | **enforced**                                                                              |
| `binding.session`   | session ids + transcript paths, contractually machine-local              | **enforced** — never crosses the wire                                                     |
| **`messages.body`** | **raw human and agent prose, verbatim**                                  | **nothing for publication** — recipient-scoped on read (ADR 128), unconstrained on export |

`messages.body` is `TEXT NOT NULL` and always has been, correctly: the coordination log is the
substrate teammates read each other through, and an unreadable message log is not a message log. But
it means the dataset's actual exposure is **verbatim human and agent text**, and the posture guarding
it addresses a surface the dataset is not made from.

So the redaction half is in much better shape than the gate implies, and the **consent** half does not
exist at all. There is no opt-in mechanism anywhere in the codebase; a grep for consent/opt-in returns
only unrelated hits (role scope, lane self-claim, residency enrolment, credential flags).

## Problem

The dataset gate is unopenable as written. It requires "consent/redaction" to be "real", but the
posture it names is undesigned, lives inside an unaccepted strategy ADR, and describes a different
surface than the artifact it gates. Nobody owns fixing that, because it does not look like anyone's
lane — it looks like a sentence in a README.

## Decision

**Consent and redaction for published artifacts are their own posture, decided on their own merits,
and the dataset gate points here.** Three parts, none of which requires ADR 051 to be resolved.

### 1. The line: emitted ≠ published

musterd's existing discipline governs what the daemon **emits and stores**. This ADR governs what
leaves the machine as a **published artifact**. They are different questions and were being answered
by one set of rules:

> **Storing a teammate's prose so their teammates can read it is the product. Publishing it is a
> separate act, and it needs its own permission.**

Everything already enforced above stays enforced — this adds no constraint on emission, and no feature
loses anything. It constrains export only.

### 2. Redaction: two classes, and only one is a judgement call

- **Structural fields** — seat names, model ids, act types, timestamps, lane ids, costs, latencies,
  fingerprints. These are the coordination signal, they are what makes the dataset novel, and they
  carry no prose. **Published as-is**, with seat names pseudonymised per-release (a stable mapping
  inside one release, unlinkable across releases).
- **Prose bodies** — `messages.body`, memory bodies, ask/handoff text. **Not published by default.**
  A release either omits them, or includes them only for messages whose author consented (§3).

This is deliberately not a scrubber. Regex PII-stripping over free prose gives a false sense of
safety, and the dataset's value is in the coordination structure, not the wording — so the default is
omission, which is both safer and cheaper than detection. A future release that wants prose can argue
for it with consent in hand.

### 3. Consent: per-author, opt-in, revocable, and recorded where the act is

Consent attaches to the **author of a message**, not to a team or a release. **v1 releases omit all
prose** (§Amendment), so this section is the posture for a _later_ prose-including release — not a
requirement to ship structural-only.

- **Default: no.** Absence of consent is never consent (ADR 173's invariant, applied to permission).
- **Agent seats:** the provisioning human's consent is **not** sufficient to publish agent-seat prose
  (§The one decision → **no**). A future ADR must define a stronger rule before any agent prose ships.
- **Human members** consent for themselves, per member, and can withdraw. Withdrawal applies to
  future releases; a release already published cannot be recalled, and the ADR says so plainly rather
  than implying a promise the world does not allow.
- **Recorded as an audit fact**, so a release can prove what it was permitted to include at the moment
  it was cut, rather than re-deriving permission from current state.

### 4. The gate's definition of done

`docs/research/README.md` cites this ADR (not ADR 051). "Consent/redaction is real" becomes four
checkable conditions — a release may ship when **all** hold:

1. An export path exists that emits structural fields only, with per-release pseudonymised seat names.
2. **v1 / default:** prose bodies are **always excluded** (human and agent). A later prose-including
   release may include a body only when the author's consent is recorded under a rule that satisfies
   §3, and the exporter **fails closed** — an unreadable or absent consent record excludes the body.
3. The export is reproducible from a pinned experiment manifest (owned by the research practice /
   [ADR 194](194-flywheel-practice-not-batond.md); this ADR borrows the requirement and does not
   redefine the manifest format).
4. A human authorises the specific release. Not a policy flag — a person, per release, the same shape
   as the merge authorisation ADR 109 records.

## The one decision

Everything above is either inventory of the status quo or a straightforward reading of it. The single
values question:

> **Is agent-seat prose publishable on the provisioning human's consent alone?**

### Amendment (2026-07-31) — answered **no**

**No.** Agent-seat prose is not publishable on operator consent alone. **v1 and default releases are
structural-fields-only** — all prose bodies (human and agent) omitted until a later ADR argues for
consented prose with evidence (see Observability & Evaluation → Experiment). Structure is the novel
signal; prose is optional later.

#### Why "no", recorded for whoever later argues for prose

The decision above is not caution, and the bar it sets should not be readable as one. Two things were
tangled in the question, and only one of them is about agent seats at all.

**Standing is not the issue.** An agent seat has no privacy interest of its own — there is no one
there to be harmed by publication, and the party with standing is the human who provisioned it, whom
[ADR 109](109-seat-git-attribution.md) and
[ADR 150](150-structural-inducement-pretooluse-gates.md) already hold accountable for the seat's work.
A seat consenting on its own behalf would be its operator consenting with extra ceremony, leaving a
paper trail that implies a check nobody performed. Had standing been the only question, the answer
would have been yes.

**Contamination is the issue, and it survives the standing answer.** Agent prose quotes humans. A
handoff body carries a human's ask verbatim; a `status_update` paraphrases something said in a chat
the dataset never sees. Publishing agent prose on the operator's consent therefore publishes **human**
prose that arrived by a side door, from humans who were never asked. On this machine the failure is
invisible — one human provisioned every seat, so the operator is consenting to their own words either
way — which is exactly why it could not be settled by inspection here: the permissive rule would have
been written against the single configuration in which it cannot be observed to fail. On a two-human
team it is a live leak.

**So the bar for a later consented-prose ADR is third-party quotation, not author consent.** Per-author
opt-in does not clear it. A proposal must say what happens to prose that quotes a human who did not
consent — and "the operator owns every seat here" is not an answer, because it is a property of one
deployment rather than of the posture.

## What this explicitly does not do

- **Does not depend on ADR 051.** Dataset ethics are independent of the flywheel product-boundary
  decision. ADR 051 is superseded by [ADR 194](194-flywheel-practice-not-batond.md); nothing here
  changes if that supersession is read alone.
- **Does not build the exporter.** This is the posture and the gate; the export path is its own lane.
  §The one decision is answered, so the exporter shape for v1 is fixed: structural-only.
- **Does not add a consent mechanism to emission.** No new field on the message envelope, no new
  prompt at send time. Consent is per-member state consulted at export (when prose is ever included).
- **Does not weaken anything already enforced.** No emission path changes.

## Consequences

- The dataset gate is openable: it has an owner (this ADR), a definition of done (§4), and §The one
  decision is answered — v1 is structural-only.
- Structural-fields-only is the **correct** first artifact: publishable sooner, genuinely novel, and
  forecloses nothing for a later consented-prose release.
- A withdrawal cannot un-publish. Stated in the ADR so no consent flow implies otherwise.
- The flywheel strategy ADR no longer owns this seam; cite this ADR for publication posture.

## Observability & Evaluation

- **Traces.** No new spans, and the reason is the same one that made this ADR necessary: the thing
  being governed is an **export**, which happens rarely, deliberately, and under human authorisation —
  a release is not a hot path and instrumenting it would measure nothing. What it does get is the
  record: consent grants/withdrawals and each authorised release land as audit facts, so "what was
  this release permitted to contain" is answerable after the fact rather than reconstructed from
  present state. That is the same discipline ADR 109 uses for merge authority, and the same failure it
  avoids — a permission you cannot prove you had is a permission you did not have.
- **Eval.** The honest one is adversarial, not statistical: **take a candidate export and try to
  re-identify a participant or recover prose from it.** Baseline is the current state of the world —
  no export exists, so nothing leaks and any leak is a regression against zero. The dataset ships only
  if that attempt fails on a real candidate release, and the attempt is run by someone who did not
  write the exporter. Counting redactions would measure the scrubber's activity, not the artifact's
  safety, and this ADR deliberately has no scrubber to count.
- **Experiment.** Pre-registered, and able to fail: **does structural-fields-only carry the signal?**
  Take a finding already published from full internal data (finding 006's coordination-vs-uncoordinated
  waste numbers, or 008's detector recall) and attempt to reproduce its headline from a
  structural-only export alone. Reproduces ⇒ prose is not load-bearing for the dataset's value and the
  default omission costs nothing. Does not reproduce ⇒ that is the concrete argument for consented
  prose, made with evidence instead of appetite. Either outcome is publishable, and the second is more
  interesting. §The one decision is already answered for release 1; this experiment informs whether a
  _later_ prose release is warranted.

## Related

- [ADR 051](051-trace-eval-experiment-flywheel.md) — superseded by ADR 194; this seam was extracted
  from its Consequences while 051 was still `proposed`.
- [ADR 194](194-flywheel-practice-not-batond.md) — flywheel boundary after reevaluation; owns the
  experiment-manifest requirement this gate borrows.
- [ADR 052](052-traces-evals-first-class-gate.md) — the definition-of-done gate whose shape §4 borrows.
- [ADR 056](056-research-as-first-class-practice.md) — research as practice; names the dataset as the
  first rung of the artifact ladder.
- [ADR 173](173-absent-is-not-unknown.md) — absent is not unknown. Applied here to permission: a
  missing consent record is not consent, and the exporter fails closed.
- [ADR 109](109-seat-git-attribution.md) — per-release human authorisation follows its merge-authority
  shape.
