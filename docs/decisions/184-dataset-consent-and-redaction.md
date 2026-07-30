# 184 — The dataset gate: consent and redaction as a posture of their own

- Status: proposed — **and deliberately small, because it exists to be decidable.** One question needs
  answering (§The one decision); everything else here is inventory of what is already true.
- Date: 2026-07-30
- Authored by izzo (lane `01KYRNHVWNKXR0M9PHGREJDN6S`), at nick's direction.
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

Consent attaches to the **author of a message**, not to a team or a release:

- **Default: no.** Absence of consent is never consent (ADR 173's invariant, applied to permission).
- **Agent seats** consent through their operator: a seat's consent is the consent of the human who
  provisioned it, declared once per seat, because an agent cannot meaningfully consent on its own
  behalf. This must be stated explicitly rather than assumed, since it is the case that would
  otherwise be silently taken as yes.
- **Human members** consent for themselves, per member, and can withdraw. Withdrawal applies to
  future releases; a release already published cannot be recalled, and the ADR says so plainly rather
  than implying a promise the world does not allow.
- **Recorded as an audit fact**, so a release can prove what it was permitted to include at the moment
  it was cut, rather than re-deriving permission from current state.

### 4. The gate's definition of done

`docs/research/README.md` stops citing ADR 051 and cites this ADR. "Consent/redaction is real" becomes
four checkable conditions — a release may ship when **all** hold:

1. An export path exists that emits structural fields only, with per-release pseudonymised seat names.
2. Prose bodies are excluded unless the author's consent is recorded, and the exporter **fails closed**
   — an unreadable or absent consent record excludes the body rather than including it.
3. The export is reproducible from a pinned manifest (ADR 051's experiment-manifest requirement, which
   this borrows and does not redefine).
4. A human authorises the specific release. Not a policy flag — a person, per release, the same shape
   as the merge authorisation ADR 109 records.

## The one decision

Everything above is either inventory of the status quo or a straightforward reading of it. The single
question that needs nick, because it is a values call and not an engineering one:

> **Is agent-seat prose publishable on the provisioning human's consent alone?**

A "yes" makes the dogfood corpus largely publishable today, since nick provisioned every agent seat on
this machine — which is precisely why it should be answered deliberately rather than assumed. A "no"
means the first release is structural-fields-only, which is still the novel artifact (no incumbent has
coordination structure over real human+agent teams), just without quotable prose.

**This ADR does not need answering to be useful.** Parts 1, 2 and 4 stand either way; the answer only
sets what a first release contains.

## What this explicitly does not do

- **Does not resolve ADR 051.** The flywheel decision stays `proposed` and this ADR does not depend on
  it. If 051 is later accepted, rejected, or superseded, nothing here changes.
- **Does not build the exporter.** This is the posture and the gate; the export path is its own lane
  and its own increment, and it should not be built until §The one decision is answered, because the
  answer changes its shape.
- **Does not add a consent mechanism to emission.** No new field on the message envelope, no new
  prompt at send time. Consent is per-member state consulted at export.
- **Does not weaken anything already enforced.** No emission path changes.

## Consequences

- The dataset gate becomes openable: it has an owner (this ADR), a definition of done (§4), and a
  single blocking question (§The one decision) instead of an undefined dependency on an unaccepted ADR.
- The first release is probably structural-fields-only, and that is a **better** first artifact than
  waiting: it is publishable sooner, it is the part that is genuinely novel, and it forecloses nothing.
- Somebody must answer §The one decision before the exporter is built. That is the intended cost — the
  question was always there, buried in a README sentence, and this surfaces it.
- A withdrawal cannot un-publish. Stated in the ADR so no consent flow implies otherwise.
- ADR 051 gains a pointer here and keeps its two-line direction as strategy. Its "each gets its own ADR
  when built" line is now true of this seam.

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
  default omission costs nothing, which retires §The one decision as a blocker for release 1.
  Does not reproduce ⇒ that is the concrete argument for consented prose, made with evidence instead of
  appetite. Either outcome is publishable, and the second is more interesting.

## Related

- [ADR 051](051-trace-eval-experiment-flywheel.md) — the flywheel strategy this seam was extracted
  from; still `proposed`, and deliberately not a dependency.
- [ADR 052](052-traces-evals-first-class-gate.md) — the definition-of-done gate whose shape §4 borrows.
- [ADR 056](056-research-as-first-class-practice.md) — research as practice; names the dataset as the
  first rung of the artifact ladder. Also `proposed`, also not a dependency.
- [ADR 173](173-absent-is-not-unknown.md) — absent is not unknown. Applied here to permission: a
  missing consent record is not consent, and the exporter fails closed.
- [ADR 109](109-seat-git-attribution.md) — per-release human authorisation follows its merge-authority
  shape.
