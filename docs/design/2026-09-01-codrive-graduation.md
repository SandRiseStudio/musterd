# Co-drive graduation: stakes-driven posture, the one-button wake, and seat-2 enrollment

**Status:** design exploration — decisions recorded from a live whiteboard session, not yet ADRs
**Date:** 2026-09-01
**Participants:** nick (human admin), izzo (facilitating seat)
**Source:** whiteboard `musterd-user-agent-flow` (clusters: CO-DRIVE TODAY, STAKES → PERMISSION
POSTURE, ONE-BUTTON WAKE, FIRST RUN), building on the 2026-08-26 session
(`docs/design/2026-08-26-musterd-user-agent-flow.md`).

## Why this session happened

Co-drive — a human opening a session in an agent's worktree, prompting "lets continue", and
following along — is nick's primary mode today and the mode we want users to be able to grow
past. This session decomposed what co-drive actually does, and designed the surfaces that
absorb each piece. Three threads emerged, and they interlock.

## 1. Co-drive, decomposed

Nick's actual ritual: open terminal in the agent's worktree → start the harness → prompt
"lets continue" → the agent orients and handles tier 1 alone → the agent asks which tier-2
item to take. Observations that fell out:

- The human's in-session role is **session starter + tier-2 dispatcher**, not steerer.
  Mid-session clarifications happen but are infrequent.
- The one thing that anchors the human to the transcript routinely is **answering harness
  permission prompts** — and nick already waives those (auto mode) for work he privately
  judges low-stakes (miley's UI lanes).
- Session start is a hand-executed wake; the tier-2 pick is an act-shaped decision that
  could arrive on the queue. Nick is comfortable answering it from another surface — and
  mostly comfortable with the agent deciding for itself, given validation (fresh lanes/acts,
  fits role and prior work) and a retained ability to course-correct (steer, any surface).

**Conclusion:** nothing routine requires eyes on the transcript. Co-drive survives as an
option for building trust, not a requirement. What must be built: the stakes policy (§2),
the wake button (§3), and both compose into seat-2 enrollment (§4).

## 2. Stakes → permission posture

### Two leashes, kept distinct

- **Knob 1 — harness permission mode**: whether the harness prompts per tool call in-session
  (Claude Code auto mode et al.).
- **Knob 2 — musterd acceptance**: whether a finished lane needs a second seat's acceptance
  (ADR 234), and whether costly actions raise asks.

Decisions (nick):

- **Low stakes means both leashes off** — the lane skips acceptance entirely, no second pair
  of eyes. Examples: straightforward bug fix, straightforward initial feature work, UI work.
- **Auto tool-permissions are acceptable on any lane whose side effects cannot escape the
  PR chain** (edit files + open PR only; no restarts, deploys, network sends, spend) — the
  axis is *escape-from-review*, not file location. The initial UI-vs-server split was an
  expedient, not a principle.

### Who defines low

- An agent tagging its own lane low is an agent approving itself — circular, ruled out.
- **Human admin(s) define what counts as low** as team policy, from their own
  company/team/project/personal perspective. musterd ships a conservative default
  (everything normal, a tiny low list) the admin widens; policy is a file, reviewed like
  code, same as the roster.
- **Stakes are derived from policy, never declared by the seat.** Policy maps work classes
  (initially scope surfaces) to stakes; a lane's stakes = policy applied to its scope. The
  agent controls scope, and scope is enforceable — the ADR 150 gate blocks out-of-scope
  writes, so lying about scope is caught at the first write. Uncovered surfaces default to
  normal.

### Graduating categories

"Straightforward bug fix" is a per-lane judgment scope globs cannot see. Resolution:

- Admin-blessed **categories** decide low mechanically (option 1).
- Outside them, an agent may **propose** low — each proposal needs a human confirm at first.
- When musterd sees ~3 human approvals of the same **named** category of work (the agent
  names the category on the proposal; the human validates the name at each approval), it
  offers to promote that category into policy — one tap. Approvals are training data; the
  queue shrinks itself; the policy file ends up documenting what the team learned to trust.

### Posture is launch-only

- **Posture never tightens mid-session; only a new session changes it** (nick). The wake is
  the single point where posture is decided.
- Corollary: the gate refuses a lane claim that outranks the session's posture; the path to
  a high-stakes lane is an ask → a deliberate wake with the high leash.

## 3. The one-button wake

ADR 131 residency built the mechanism (wake actuator, ledger, session capture, metrics,
~$1.21 measured per wake). The gap is the trigger surface. Two wake flavors, split by
boundedness:

- **Work-session wake** — the "lets continue" equivalent: long-lived, agent orients,
  handles tier 1, self-selects tier 2 under the stakes policy. **This is the button** on
  /live (per seat row; CLI twin verb), and **any human on the team may press it** — a peer
  gesture, not an admin power. A bare wake launches at posture *normal*; low lanes are
  covered, high lanes bounce through an ask.
- **Scoped wake** — one ask, then spin down; typically agent-triggered (help, urgent
  directed acts). **Ungated: no approval, any actor** — the urgency case must never queue
  behind a human tap.

The inversion is the design's justification: the agent path is ungated because it is
*bounded* (cost capped per wake); the open-ended path sits behind a deliberate human press.
Boundedness, not the actor, buys gatelessness.

Runaway protection already exists and was verified in-session:
`packages/protocol/src/residency.ts` — per-enrollment `cooldown_ms` (default 30m),
`hourly_cap` (default 2, max 20), `budget_usd` over-budget flagging in the ledger; deferrals
burn no budget; the re-wake-on-shipped-handoff loop was fixed by handoff discharge.

## 4. Seat-2 enrollment

The FIRST RUN metric — *does sitting 1 produce a second enrolled seat?* — gets a mechanism:

- **"Enrolled" has a mechanical test: the wake button works.** Seat 2 is done when its
  /live row shows a pressable button that starts an oriented session at the right posture.
- **The recruit moment is a concrete blockage**: the first lane hits awaiting-acceptance
  and no second seat exists (acceptance is the built-in first coordination moment), or a
  lane waits on a role nobody holds. The agent proposes *creating* a named seat for the
  role.
- **The approval tap does all the infra** (nick): mint seat, create worktree, wire harness,
  enroll — executed by musterd as an attributed service action (ADR 232), not handed back
  to the human as a command to run. The same button surface starts sessions for existing
  agents.
- **Model/harness choice** (leaning, not settled): role definitions (ADR 227 library) carry
  recommended models/harnesses; the setup prompt pre-fills the recommendation and the human
  confirms or overrides. Keeps ADR 056/101 diversity guidance authored once, in the role
  library, with the human as chooser at creation.
- **After enrollment, no further taps** (nick): the pending acceptance is a directed act, so
  an ungated scoped wake fires, seat 2 orients and accepts the waiting lane. **One human
  gesture from solo tool to working team.**

## How the threads compose

```
stakes policy (admin-authored, categories graduate)
        │ derives posture
        ▼
wake = the single point posture is set (launch-only rule)
        │ button (work-session, any human) / ungated scoped (bounded)
        ▼
seat-2 enrollment = "the button works" — propose → one tap → infra → scoped wake → first acceptance
```

## Open questions

- Similarity notion for category promotion is co-authored naming — does it hold up when two
  agents name the same work differently?
- Harness posture adapters beyond Claude Code (cursor/codex "set posture at launch") — same
  family as the doctor's baked-env inspection.
- Whether trailing audit of low lanes (sampling shipped-without-acceptance lanes) is wanted
  as a backstop once volume grows; deliberately not adopted now.
- The human copresence lane/concept is broken today and needs reevaluation — deliberately
  out of scope here; co-drive stays unmodeled (work attests as the agent) by choice.

## What this is not

Not ADRs. The stakes→posture model, the two wake flavors, and enrollment-as-button each
warrant one when implementation starts; the launch-only posture rule and low-skips-
acceptance are the decisions most worth pinning first, since other pieces lean on them.
