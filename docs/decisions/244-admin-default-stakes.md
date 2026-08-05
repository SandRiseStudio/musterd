# 244 — An admin can default a surface's stakes, and the ledger still knows who decided

- Status: accepted
- Date: 2026-08-05
- Deciders: nick (asked for it), miley (opened the lane, named the measurement trap, and changed her
  own position on the record), stanley (built it)
- Amends: [ADR 234](234-tiered-acceptance.md) — adds the policy source and the provenance split its
  Eval needs to survive one

## Context

ADR 234 increment 2 shipped a real exemption: a lane declaring `stakes: 'low'` routes no acceptance
ask, except a 1-in-5 sample. It is per-lane and opt-in, so nick's standing intent — _"default to
stakes low for any front end changes (this type of default/selection should be configurable by team
admin(s))"_ — was satisfied only by every seat **remembering** to declare it. Per-seat memory is not
a policy; it is a hope with a good week and a bad one.

## Problem

The obvious implementation is the surface-path rule **this ADR's parent explicitly rejected**, and it
would be wrong to ship it without saying so.

ADR 234 rejected inferring stakes from the surface because _surface complexity predicts review COST,
not review VALUE_ — the two most valuable reviews of 2026-08-04 were both on docs. That reasoning has
not changed and is not being softened here.

**What changed is the actor, not the rule.** ADR 234 rejected _the system_ inferring value from a
diff. An admin declaring "on my team, web lanes start low" is not an inference: it is an accountable
human making a revocable, attributable, visible choice — which is exactly the kind of judgement ADR
234 wants `stakes` to carry. miley put this distinction, having argued the other side of it the same
day, and it is the hinge of this decision.

There is a second problem, and it is the one that would have done lasting damage:

> **If a policy writes `stakes: 'low'`, the ledger can no longer tell "the worker judged this low"
> from "policy assumed this class is low".** ADR 234's rollback condition is whether **declared**
> stakes predict the answer rate. Pooling worker judgement and policy default into a single `low`
> bucket destroys that signal — silently, permanently, and in the direction that makes the exemption
> look justified. It is the same confound class as the acceptor monoculture, arriving through a
> feature instead of an accident.

## Decision

**1. Team policy carries `stakes_defaults`: an ordered list of `{surface, stakes}` rules.** Admin-set
through `POST /teams/:slug/policy` like every other knob (ADR 185 sparse-on-write). `parse({})`
yields an **empty list**, so this is inert until a team asks for it — the same opt-in posture as
`enforcement` and `loops`.

**2. Every lane records `stakes_provenance`: `declared` | `defaulted`.** `defaulted` is written only
where a rule actually fired. `declared` is the honest default for everything else **including
silence**, because ADR 234 §2 already ruled that absence IS the declaration — an unstated `normal` is
the worker's answer, not a policy's. It is stamped into the `lane.ready_for_review` audit row beside
`stakes`, and **the Eval must split on it.**

**3. The rule resolves at `lane_open` and never again.** This is ADR 234 increment 2's own discipline
applied one edge earlier: that increment forbade deriving the close reason from live `stakes` because
stakes are editable, so a late read would let an edit rewrite history. A policy resolved late is a
policy that can rewrite history, and the same argument forbids it.

**4. An explicit declaration always wins, in either direction, and records `declared`.** Upward
override is deliberately frictionless: a seat that believes its web change deserves eyes must be able
to say so without an admin. A seat that declares `low` where policy would also have said `low` still
records `declared` — crediting the policy with a judgement the worker made would inflate the policy
bucket with lanes that prove nothing about it. **Editing stakes after open takes ownership** and
flips provenance to `declared`, so an override never keeps counting toward the policy it overrode.

**5. A lane matches only when EVERY declared surface falls under the rule.** Not `any`, and the
asymmetry is the safety property: if `any` matched, a worker could exempt a server change by naming
one web file beside it, and the exemption would be one glob away from anything. A lane declaring **no
surface** matches nothing and stays `normal` — a lane that did not say where it works has not earned
a surface-based default. Matching is a `/`-terminated **prefix**, not a glob engine: predictable
beats expressive for a value that silently changes who reviews the team's work, and the termination
is what stops `packages/web` from swallowing `packages/webhooks`.

**6. The ADR 172 tension is a knowing trade, recorded rather than discovered.** nick's standing rule
is that all web UI must be magical/warm/on-brand, and ADR 172 routes user-facing work to a **human**.
A web-defaults-low policy deliberately overrides that for this team. He has chosen this axis twice,
with the contradiction put to him explicitly the first time, so it is decided — it just needs to be
written down where the next reader will find it.

## Consequences

- A worker's lane can now be exempted from acceptance by a policy they did not set. The submit
  response says so (`stakes_provenance` rides the exempt hint) rather than letting acceptance
  silently skip their work — the invisible-consequence failure [ADR 237](237-supersession-must-be-visible.md)
  named for supersession, one surface over.
- `stakes` becomes a field with two authors. Everything downstream that reads it must now ask which
  one, and the provenance field is the only honest answer.
- **The standing argument against going further, from miley, and it cuts against her own default:**
  her four web lanes on 2026-08-05 all routed `normal`, and acceptance caught two real defects on one
  of them (#687 — ryder returned two valid notes). Both were on a lane a blanket path rule would have
  exempted. That is one measured data point against blanket web exemption, and it is why the sampling
  hole stays and why the upward override must stay frictionless.
- Her working distinction — declare `normal` when a web change alters what a surface **asserts as
  fact** (counts, recipients, routing claims) rather than only how it looks — is deliberately **not**
  encoded in the policy. The moment a config tries to express it we are back to inferring value from
  surface, which is the thing this knob is admissible for not doing. It belongs in the seat's
  judgement and in `packages/web/AGENTS.md`, and the upward override is what it acts through.
- Migration **v36**, and how it got there is the point. It was written as v35 while ryder's wake
  token and kimi's footprint tables both held unmerged claims on v34/v35; asking in-band beat
  discovering it, and the rebase then moved it to v36 with the sequence still dense. Two branches
  claiming one version produce a database whose applied schema depends on merge order and a
  `schema_meta` number meaning different things on different machines — the v32 collision izzo and I
  both wrote last week, which nothing but a merge conflict caught. A `migrations:check` gate on
  duplicate versions is still owed and this is the third week running it would have paid for itself.

## Observability & Evaluation

**Traces.** `stakes_provenance` on every `lane.ready_for_review` row beside `stakes`, recorded
unconditionally for the same reason `stakes` is — a field that vanishes on its common value makes the
largest bucket the one the Eval cannot count. `policy.change` already audits the rule set itself, so
when a default was introduced is answerable from the ledger without a code archaeology pass.

**Eval.** ADR 234's report gains one required split. Every tier number is reported **by provenance**:
`low/declared`, `low/defaulted`, `normal/declared`, and so on. Three questions this makes answerable
that were not before:

1. **Composition** — what fraction of `low` is policy rather than judgement. If `defaulted`
   dominates, ADR 234's rollback test is running on a sample of policy assumptions, not declarations.
2. **Whether the policy default agrees with the workers it replaced.** The upward-override rate on
   defaulted surfaces is the direct measure: a rule that seats routinely override is a rule set
   wrong, and that is visible without waiting for a defect.
3. **Whether defects concentrate in `defaulted`.** The counter-metric that would condemn the knob.

**The decision rule, pre-registered.** ADR 234's rollback condition is evaluated on
`stakes_provenance: 'declared'` lanes **only**. Policy-defaulted lanes are excluded from it by
construction — they are not evidence about whether declared stakes predict anything, and including
them would let this ADR quietly answer its parent's open question in its own favour.

**A limitation stated up front:** the upward-override rate is only interpretable where seats know the
default fired. It is surfaced on the lane and in the submit response today; if a future client hides
it, that metric degrades silently and the Eval should treat it as unavailable rather than as a zero.

**Experiment.** None. This is a knob whose effect is measured by the split above, and its honest test
is the first month of `defaulted` lanes on a real team.
