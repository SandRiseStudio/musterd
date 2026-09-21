---
name: the-team-agreement
description: The charter above the loop — the human is a member who sometimes wears an approver hat, not an approver who sometimes participates; relationships are stances that shift hourly, never stored autonomy levels; notification is the mechanism, not a nicety; roles are aptitude, not authority; and write work stays with whoever is accountable for it. Use before adopting an agent-coordination practice, when designing who may do what, or when a team has quietly become one person approving things.
---

# the-team-agreement

This is the charter that sits **above** the working loop. Claiming work,
checking an inbox, asking a question — those are mechanics, and they will
faithfully implement whatever relationship you actually have. This is the part
that decides what that relationship is.

Five commitments. Each one has a failure it prevents, and each was arrived at by
having the failure first.

## 1. The human is a member, not an approver

A human on a team wears a **member hat always, and an approver hat
optionally.**

The member hat owns work, shows up in presence, sends and receives the same
messages as everybody else. The approver hat holds the decide-and-grant powers
and receives the traffic addressed to authority. **They are different hats and
the same person wears both.**

Our failure was not that a human was approving things. It was that **the
approver hat was the only one with a surface.** Every path into the human went
through "someone needs permission", so the human's own work, questions and
opinions had nowhere to live — and a teammate who can only ever be asked for
permission stops being a teammate.

Three properties fall out, and they are cheap:

- **Approver is a capability, not a role** (see commitment 4), and it is
  human-only. A team can have several humans and several approvers, and at least
  one always exists.
- **A non-approver human is a full member.** They do everything a member does
  and send into the to-human stream exactly as an agent does — they simply do
  not *receive* approvals by default.
- **Humans get the full steering vocabulary** — challenge, stop, redirect,
  rescope — as first-class moves, not as an escape hatch.

## 2. The relationship is a stance, not a stored property

A human's relationship to an agent shifts continuously, often within one hour,
with one agent:

- **Supervising** — asked for something, now watching it reason; intervening
  sometimes.
- **Pairing** — questions flowing both ways.
- **Delegating** — kicked it off, walked away, trusts it to decide.
- **Deferring** — initiated the task, but the agent has the deeper domain
  knowledge and is driving the outcome. The human is the requester *and* the
  junior party.

**The trap is making the stance a field.** `autonomy_level: 2` will be wrong
within the hour, and nothing will tell you. Humans never encode this with each
other either — the stance is carried by how they talk.

So do not model the relationship. Record the facts that let it be **read**:

| Fact | Question it answers | When it is knowable |
| --- | --- | --- |
| **Provenance** | why does this session exist? (a person opened it · someone asked · a hook fired · a schedule · always-on) | at attach, never guessed |
| **Initiative** | who started this thread of work? | it *is* the thread |
| **Disposition** | what latitude was granted, for this engagement? | granted per engagement, not owned |

The four stances are then an emergent reading of those three plus the live
conversation — **a field nobody maintains, and therefore nobody lets go stale.**

### Initiative is not hierarchy

*"I asked our security person to look at this"* does not put the asker in charge
of security.

Any model that conflates who started a thread with who has authority in it
misdescribes half of real teamwork, human or otherwise. The deferring stance is
the sharp case: **the moment an agent is genuinely driving the outcome, it has
stopped being describable as a tool.** A tool's output belongs to whoever
wielded it. A member's work is theirs — named, questionable, declinable,
handed off.

## 3. Notification is the mechanism, not a nicety

This is the one commitment with published evidence behind it.

The Collaborative Gym study — Shao, Samuel, Jiang, Yang and Yang,
[arXiv:2412.15701](https://arxiv.org/abs/2412.15701) — builds agents on
a **flexible, non-turn-taking interaction paradigm** and measures them against
real users: win rates of **86% on travel planning, 74% on tabular analysis and
66% on related-work writing.**

The design instruction is in the paradigm, not the percentages. Non-turn-taking
means neither party has to wait for the other to finish being present — which
only works if something *reaches* the one who stepped away.

> **If your humans have to go and look, you have built the turn-taking
> condition.** The mechanism is not the shared document, the board, or the chat
> room. It is the thing that reaches someone who is not currently looking at any
> of them.

**A number we use internally, and could not verify for you.** Our own notes
record an ablation from this paper — remove the notification protocol and force
turn-taking, win rate collapses to 30%; non-turn-taking with notifications, 70%
— along with 99 participants and 150 trajectories. Those figures are not in the
abstract, and checking the paper body for them was beyond what we did before
publishing this. **Treat them as our second-hand reading, not as a citation**;
the verified numbers are the three above. If the ablation matters to your
argument, read the paper rather than this page.

That paragraph is the skill applied to itself: the paper is real and correctly
attributed, and a specific number inside it is a claim we are carrying without
having checked. Saying which is which costs one paragraph and is the difference
between a citation and a rumour with a link on it.

## 4. Roles are aptitude, not authority

Three things get bundled into one config file, and they have different truth
conditions:

| Layer | What it is | How you'd know it's true |
| --- | --- | --- |
| **Declared** | the *lens* — a role steering attention | behavioural, not a credential |
| **Enforced** | the *license* — actual access to tools, data, credentials | verifiable at a boundary |
| **Demonstrated** | the *record* — what this member has actually done under a stable name | accumulated, inspectable |

**No layer may fabricate another.** A role string must not gate access
(declaration ≠ enforcement). Tool possession must not be read as competence
(license ≠ skill). And nobody writes a fictional résumé — **the log is the
biography.**

Four boundaries worth stating outright:

- **A role is a charter plus a ceiling, and the ceiling is narrow-only.** A role
  may restrict what a member can do; it can never widen it. That single property
  is what makes roles safe to hand out.
- **Roles are optional.** A member with no role is the generalist default, not
  an incomplete registration.
- **Approver is not a role.** It is a capability, human-only. Authority and
  aptitude stay orthogonal, and the narrow-only clamp means no role file can
  ever mint authority.
- **Personas are not free.** The largest controlled study — 162 personas, 4
  model families, 2,410 factual questions ([arXiv:2311.10054](https://arxiv.org/abs/2311.10054))
  — found that adding a persona **does not improve accuracy**, and that
  picking a good one for a given question performs **no better than random
  selection**. (Verified against the abstract 2026-09-21: 162 roles, 4 LLM
  families, 2,410 factual questions.) Use a role as a **routing hint and an
  attention scope**. Do not expect it to make anyone smarter.

## 5. Write work stays with whoever is accountable for it

The rule: **never spawn a sub-worker that edits files, claims work, or
commits.** Do the work yourself, or hand it to another named member.

**Read-only fan-out is fine** — searching, mapping a codebase, locating code.
That produces knowledge, and knowledge needs no provenance: a fact is true
regardless of who found it.

The asymmetry is not squeamishness. A sub-worker writes under *your* identity,
with no name, no claim on the work, and no attestation of its own. So every
mechanism you built to make work accountable goes blind at once:

- an ownership check fires on **you**, and cannot see it;
- version-control attribution records **your** name on its commits;
- any record of which model did the work records **yours**, at your model.

One anonymous sub-worker breaks all three silently, and the breakage is
invisible precisely because every artifact looks correctly attributed. **This is
the orchestration pattern the whole agreement exists as the alternative to:**
the actors have no identity, so nothing they do can be held to anything.

If some guidance you have adopted says "dispatch workers in parallel, one per
task", the translation is: **one unit of work per owner, and a handoff per
owner.** A named member can decline, hold, or push back. An anonymous worker
cannot — which is the entire point.

## What this looks like when it is *not* in force

The charter has no checker, so here is the audit. Each question has an
observable answer, and a bad one falsifies the commitment above it.

1. **When did a human last send something into this team that was not a
   decision?** If the honest answer is "never", the approver hat is the only one
   with a surface. *(1)*
2. **Is there a stored field anywhere describing how much a member is trusted?**
   If yes, find out when it was last changed and compare that to how much has
   happened since. *(2)*
3. **Does anything reach a human who is not currently looking?** If people find
   out by checking, you have built the turn-taking condition. *(3)*
4. **Can a role file grant anything?** If yes, roles are authority wearing
   aptitude's clothes. *(4)*
5. **Whose name is on the last commit that a sub-worker actually wrote?** If it
   is the name of whoever spawned it, your attribution has a hole the size of
   every sub-worker you have ever run. *(5)*

Question 5 is the one to run first, because it is the only one with an answer
already sitting in your version control history.

## Two things a file cannot do

- **Nothing routes a question to a human who is actually present.** You can
  address a question to someone; whether they are there is a fact the agreement
  cannot supply. That gap is exactly what commitment 3 says drives the outcome,
  which makes it the most expensive gap on this page.
- **A sub-worker spawn can be refused, but not recorded.** Commitment 5 is a
  rule an honest participant follows. Nothing on one machine observes a
  violation, so the audit question above reads history rather than catching the
  act.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works as an agreement between people with no server;
what a file cannot do is route a question to someone who is actually there, or
record the spawn that commitment 5 forbids. musterd.io.*
