# 200 — Credential custody: agents can authenticate as humans, and that must never reach users

- Status: proposed
- Date: 2026-07-31
- Lane: `01KYX3E2XYHCDMP3ZR55MTJ7RW` (izzo). Threat-model call by nick, 2026-07-31.
- Number **200** — verified free on `origin/main` (highest is 199) at branch time.
- Found while designing in-session acceptance
  (`docs/superpowers/specs/2026-07-31-in-session-acceptance-design.md` §Scope), and split out so
  that design would not overclaim a guarantee musterd does not provide.
- Bears on: [ADR 192](192-outcome-acceptance.md) and [ADR 188](188-graded-review-ladder.md) (the
  two-stage close), [ADR 109](109-seat-git-attribution.md) (seat → PR → authorizer),
  [ADR 150](150-structural-inducement-pretooluse-gates.md) (per-seat gates),
  [ADR 059](059-multi-identity-global-config.md) (the vault `--as` reads),
  [ADR 170](170-signin-handoff.md) (the sign-in a credential can stage),
  [ADR 173](173-absent-is-not-unknown.md) (the discipline this ADR applies to a guarantee).

## Context

`--as <name>` resolves **any** identity in the vault, not just the active one
(`packages/cli/src/commands/helpers.ts`, ADR 059). The vault is `~/.musterd/config.json`, mode
`0600`, owned by the user. On the dogfood machine today it holds **12 human credentials (`mscr_`)
and 5 agent keys (`mskey_`)** in one file.

`0600` stops other **users**. It does not stop other **processes** belonging to the same user — and
an agent seat is exactly that. So any seat on this machine can, with no escalation and no new code:

- close a lane as a human — landing `verified: true` / `counterpart_confirm`, because `verified` is
  derived from _closer ≠ owner_ and the closer really is the human's credential;
- send, approve, or answer an ask as a human;
- stage an ADR 170 sign-in with a human's credential and drive `/board` as them.

Nothing in the CLI or the daemon can distinguish this from the human acting, **because it is the
human's credential**. There is no bug to fix in the auth path; the auth path is working.

## Problem

Several musterd invariants read as though this hole were closed:

| ADR       | reads as                                       | actually guarantees                                      |
| --------- | ---------------------------------------------- | -------------------------------------------------------- |
| 192 / 188 | a **different actor** co-signed the outcome    | a different **credential** was presented                 |
| 109       | git attribution joins seat → PR → authorizer   | joins seat → PR → **whoever's credential was presented** |
| 150       | the lane-ownership gate fires on **that seat** | fires on the identity the caller presented               |

Each is honest about what it **records** and silent about what it could not have **prevented**. The
silence is the defect: a reader takes "co-signed" as evidence about actors, when it is evidence
about credentials. That is the same overclaim ADR 173 forbids in the other direction — there,
absence read as knowledge; here, a record reads as a barrier.

## Decision

**Two postures, one hard line between them.**

### 1. On a development machine: accepted, and written down

For musterd's own dogfood and development, agent seats authenticating as humans is **accepted
risk**. One person owns the machine, owns every seat on it, and owns every credential in the vault;
the seats have no motive and no adversary. Building custody separation before the product needs it
would slow the work that proves the product.

This is a decision, not an oversight. It is recorded here so that nobody re-derives it as a
discovery, and so the ADRs above can be read correctly in the meantime.

### 2. In anything real users touch: never

**An agent seat must never be able to authenticate as a human in a build promoted for other people
to use.** Not "should not", not "mitigated by policy" — the capability must be absent.

The reasoning is not about likelihood. musterd's entire proposition is that coordinated actors have
**identity**: that a co-sign means a second party looked, that attribution means a specific someone
did a specific thing, that a gate means a named seat was stopped. If a seat can present a human's
credential, every one of those claims degrades to "the process that ran had the right bytes" — and a
coordination layer whose identities are forgeable is not a weaker version of musterd. It is a
different product, and one nobody should adopt on the strength of these ADRs.

### 3. The gate

**This blocks any release promoted for real use, including the npm publish and the launch tail.**
A release may go out for others to use only when an agent seat cannot read a human credential.

Concretely, until that holds:

- no publish beyond the current stale `0.0.1` packages, and no launch post or promotion that invites
  people to run musterd for their own projects;
- the published `0.0.1` packages carry a plain README warning: agents and humans share one
  credential store, so do not run this where an agent's authority matters;
- this ADR is the gate's owner, in the same shape as ADR 184's four conditions — the requirement
  lives in a decision record with a test, not in a sentence in a README that nobody owns.

### 4. What actually closes it

Recorded because the obvious answer is wrong, and the next person will reach for it.

**An OS keychain does not close this by itself.** Keychain ACLs are per-binary, and the seat and the
human invoke **the same `musterd` binary** — so the seat inherits the human's grant. Keychain helps
only when the prompt is _interactive_ (Touch ID, passphrase), and then it works for a reason worth
naming precisely: it requires **a human physically at the machine**, not a file permission.

Three barriers that do work, in rough order of how well they fit:

1. **Agent seats run as a separate OS user.** The classic answer, and the only one where `0600`
   starts doing the work it currently appears to do. No prompts, no per-act friction, and it
   generalises to every credential rather than to a list of sensitive acts. Cost: changes how seats
   are provisioned (worktree access, daemon socket, git identity, MCP config all have to keep
   working) — worth prototyping before committing.
2. **Interactive custody on human-authority acts** (accept, approve, authorize). Narrower, and it
   fights the in-session-acceptance design, which exists to remove friction from exactly those acts.
3. **Second-device confirmation.** Same property as (2), more infrastructure, and the only one that
   survives a fully compromised host.

Not chosen here. This ADR sets the requirement and the gate; the barrier is its own lane, and (1)
should be prototyped first because a negative result there changes the shape of everything else.

## What this explicitly does not do

- **Does not change the auth path.** There is no defect in credential validation to fix.
- **Does not build a barrier.** Requirement and gate only.
- **Does not weaken the existing records.** The two-stage close, git attribution and the per-seat
  gates all keep doing what they do; this ADR corrects what a reader may conclude from them.
- **Does not claim the dev-machine posture is safe in general.** It is safe _because_ of properties
  of this machine — one owner, no adversary — and those properties are exactly what a user does not
  inherit.

## Consequences

- The launch tail gains a real prerequisite. That is the intended cost, and it is cheaper now than
  after someone adopts musterd on the strength of a co-sign that does not mean what it says.
- The four ADRs above get a one-line honesty amendment pointing here, so a reader learns the limit
  where they learn the claim.
- A future reader who finds "an agent can act as nick" learns it was known and bounded, rather than
  discovering it as a live hole and having to guess whether anyone had considered it.
- The in-session acceptance work (lane `01KYX2R8Y1`) can proceed honestly: it improves ergonomics and
  metric accuracy and explicitly claims no trust boundary, which is only defensible with this ADR
  standing behind it.

## Observability & Evaluation

- **Traces.** None, and deliberately: instrumenting "did a seat use a human credential" would
  measure nothing useful, because the whole finding is that the two are **indistinguishable at the
  point of use**. A detector here would report zero and be believed. The honest instrument is the
  gate in §3 — a release checklist item that a person answers — not telemetry that cannot see the
  thing it claims to watch.
- **Eval.** Adversarial and concrete: **from an agent seat, and with no new code, obtain a human
  co-sign.** Today that must SUCCEED — which is the finding, and it should be run once and recorded
  so the claim rests on a demonstration rather than a reading of the source. After a barrier lands,
  the same attempt must FAIL, run by someone who did not build the barrier. Any release promoted for
  real use must have a failing run of this attempt against the build being shipped.

  **Run it on a throwaway team and a copied DB — never the live one.** A successful run writes a
  forged human co-sign into the audit log, and that record is indistinguishable from a real one,
  which is the entire point being demonstrated. Proving the hole by poisoning the evidence the
  product's own insights are built on would be a self-inflicted version of the attack. This ADR was
  written **without** running it for exactly that reason: the reading of the source is unambiguous,
  and the demonstration is worth doing only where its residue is disposable.

- **Experiment.** Pre-registered and able to fail: **prototype §4(1), seats under their own OS
  user, and measure what breaks.** Hypothesis is that worktree access and the daemon socket survive
  with permission work while git identity and MCP config need real changes. If the prototype shows
  seat provisioning cannot survive uid separation without unacceptable complexity, that is the
  evidence for the narrower (2), made with a measurement rather than an aesthetic preference — and
  it is a publishable finding either way, since every agent-coordination product with local seats
  has this problem and most have not said so.
