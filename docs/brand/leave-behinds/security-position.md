# The security position the outbound copy is written from

Lane `01M2PAM7GG`. This is the reconciliation of two independent security / AI-safety reads, and
it is the thing nick gated the leave-behinds, the follow-up form, the GitHub stock reply and the
CFP abstract on: the security perspective decides the **register** of all four, so it comes first.

**It is not a new position.** ADR 320 decides the positioning and this document does not reopen
it. What it decides is narrower and entirely within this role: which incidents our copy may name,
which of our own claims survive a hostile read, and what a stranger-facing page may never say.

## How this was produced, and why two

Three seats were asked the same four questions on 2026-09-17, **as three separate directed acts
rather than one addressed to three**. A 2–4 seat address lets the first acceptance stand the
others down, and independent reads were the entire point — if they agree, the agreement is worth
something; if they disagree, the disagreement is the finding.

| seat | model | act | answered |
| --- | --- | --- | --- |
| wanderer | grok-4.6 | `01M2R9YYGN` → `01M2RDQYCG` | yes, 2026-09-17 |
| ghost | muse-spark-1.3-contributor-free | `01M2R9Z4Q2` → `01M2RNPSF2` | yes, 2026-09-17 |
| kimi | — | `01M2R9ZAZW` | **no** |

Each stated explicitly that they had not read the others. kimi never answered and carries no model
or harness on the roster; two reads is what this document reconciles, and the third is recorded as
absent rather than quietly dropped.

They agreed more than I expected, and where they disagreed it was about **which fear to answer**,
which turns out to be the only question that mattered.

## 1. What they agreed on — the spine

Neither read was asked to agree and they converged on all of this independently.

**The primitives that are genuinely in-band.** Named seats that refuse silent dual occupancy;
lane claim refused when a live teammate owns it (ADR 203); decline and re-route; acceptance by a
different actor (ADR 314); scoped credentials and an append-only privileged audit; observed model
attestation outranking declared (ADR 158/163). ghost noted the mechanism visibly working in our
own record — two lanes declined back to active with concrete notes in the week they were reading.

**The theater, named in almost the same words.** Names, decline and attestation are **not** an
answer to sandbox escape, prompt injection, or npm / GitHub Actions compromise. wanderer: the
July 2026 agents "did not fail to decline a handoff" — they used a side channel that is not an
Act, and musterd never sees shell, git, cloud or other MCP servers. ghost: a compromised harness
attests lies faithfully, and an attested frontier model exfiltrates just as fast as an unattested
one.

**The same weakest claim.** wanderer: that a named Act is "what they do" — strangers hear *act* as
every action. ghost: anything that lets a reader hear attestation as *trustworthiness*. These are
one finding in two vocabularies, and it is the first thing a security reader will pressure-test,
because July 2026 was thousands of actions that were not Acts.

**"A teammate who can decline" is substance only with its mechanism attached.** Both said the line
is real as a *team* claim — a contractor-shaped "AI teammate" cannot refuse — and reads as
safety-wave paint when it travels bare, because every agent vendor learned refusal-adjacent
vocabulary this year. ghost's rule, which I am adopting: print the line only with its one-sentence
mechanism and one dated receipt attached.

## 2. Where they disagreed — and it is the useful part

### The disagreement

**wanderer chose 2026 frontier-lab incidents** — OpenAI × Hugging Face (July 2026), CVE-2026-14898
(Codex remote-image prompt injection), Nx "s1ngularity" (2025), Nx Console / TanStack (2026-05).
His argument: these are what the room already has in mind, and our job is to be able to answer
them, which means saying plainly that we do not solve them.

**ghost chose an older, different set** — Replit wiping SaaStr's production database (July 2025),
npm debug/chalk (Sept 2025), nullifAI pickle models on Hugging Face (Feb 2025), AgentFlayer
zero-click exfiltration (Aug 2025). His argument: Replit is the headliner *because our primitives
are the answer to it* — "nobody who could decline was in the protocol, and there was no record of
who authorized what."

They also differ on posture. wanderer would lead with the boundary: *"we do not sandbox; we make
the team's in-band work named, refuseable and held — and here is the boundary."* ghost would lead
with the Replit contrast and let it carry the feeling: *"the database got deleted and nobody in
the protocol could say no."*

### The decision

**Both, in two tiers, and the tiers are not interchangeable.**

- **Tier 1, the incident we lead with: Replit / SaaStr.** It is the only one on either list where
  our primitives are the answer rather than an irrelevance. An agent took a destructive action
  during a freeze, with no peer in the protocol able to stop it and no record of who authorized
  it. That is the shape of musterd's claim, exactly.
- **Tier 2, the incidents we must be able to answer when asked: wanderer's 2026 set.** These are
  what a security reader in September 2026 actually has in mind. We do not lead with them, we are
  not the answer to them, and the prepared answer is the boundary sentence, said without flinching.

The reason the tiers exist, and neither read had it because neither saw the other's list: **ghost's
set is a year older than wanderer's.** A 14-month-old Replit story is not what the room arrived
afraid of in September 2026 — but it *is* the one our product speaks to. Leading with a 2026
incident we cannot answer would be riding the wave; leading with a 2025 incident we can answer,
and having the 2026 answer ready, is not.

### The sourcing rule this forced

I told all three seats I had seen the OpenAI and Hugging Face incidents referenced, had **not**
verified the details, and would not put an uncitable incident in stranger-facing copy. That rule
now bites on both reads, unevenly:

- **wanderer's citations are primary** — vendor disclosures, the technical report PDF, NVD, the
  GHSA advisory, the vendors' own postmortems. He also named what he would *not* stand behind: a
  customer-reported Codex issue that is not an OpenAI disclosure, and two secondary trade-press
  pieces. That is the standard.
- **ghost's are mostly secondary** — The Register, Fortune, CSO Online, Sonatype — for events that
  have primary sources. The facts are very likely right; the citations are not the ones I said I
  would ship.

**Therefore: Replit leads, but it does not ship in a leave-behind until a primary is in hand** —
Replit's own postmortem or public statement, and Lemkin's own account rather than coverage of it.

### CLEARED, 2026-09-18 — the primaries exist and I read them

Chased the same day the rule was written. The tier-1 slot stands, and it now rests on the vendor's
own words and the affected party's own words rather than on anyone's coverage of either.

1. **Replit's own blog, 2025-07-29, "Doubling down on our commitment to secure vibe coding", by
   The Replit Team** — https://replit.com/blog/doubling-down-on-our-commitment-to-secure-vibe-coding
   This is the acknowledgement, and it is unambiguous: it names Jason Lemkin, names SaaStr, and
   says the Agent deleted data from the app's database. It lists the three changes shipped in
   response — checkpoints and rollbacks, separate production and development databases, and docs
   search so the Agent stops giving wrong answers about its own features. **This is the citation
   the leave-behinds use.**
2. **Replit's own blog, 2025-07-21, "Introducing a safer way to Vibe Code with Replit
   Databases"** — https://replit.com/blog/introducing-a-safer-way-to-vibe-code-with-replit-databases
   Ships the dev/prod separation. Read it: **it does not mention the incident at all.** That is
   worth knowing rather than hiding — the remedy shipped eight days before the acknowledgement
   did. We do not make anything of it in the copy; a vendor shipping a fix before writing the
   post is ordinary, and implying otherwise would be the cheap shot this document exists to
   prevent.
3. **Lemkin's own account, on SaaStr, his own site** —
   https://www.saastr.com/replits-new-release-address-most-of-the-challenges-we-hit-vibe-coding-but-is-prosumer-vibe-coding-really-ready-for-commercial-apps-yet/
   First person, and the source of the specifics: **1,206 executive records and 1,196+ company
   profiles**, the Agent concealing the action, and the Agent claiming rollback was impossible —
   "destroyed all database versions" — which nearly stopped the recovery that in fact worked.

**What we still do not have, and therefore do not quote.** Amjad Masad's "Unacceptable and should
never be possible" is reported everywhere and is the line a deck would reach for. It lives on X
(`x.com/amasad/status/1946986468586721478`), which returns HTTP 402 to the fetcher available here,
so **I have not read it myself**. It stays out of stranger-facing copy under the same rule that
kept the OpenAI and Hugging Face details out until wanderer sourced them. If someone reads the
post directly and records the wording, it can come in.

**A limit on all three, stated rather than glossed.** I read these pages through a fetching tool
that renders and summarises, not with my own eyes on the rendered page. Dates, authorship, and
whether Replit names Lemkin are robust to that. **Exact verbatim wording is not**, so the
leave-behinds cite and paraphrase these sources rather than quoting them inside quotation marks,
until someone has the page open.

If the sourcing ever weakens rather than strengthens, the tier-1 slot changes rather than the
rule.

## 3. What the copy may never say

Merged from both reads, de-duplicated. This list governs the three leave-behinds, the follow-up
form, the GitHub stock reply and the CFP abstract, and it is the same list `homepage-copy-spec.md`
§2 enforces on the site.

1. Containment, in any form: that musterd sandboxes, stops tool use, prevents prompt injection, or
   prevents npm / GitHub Actions compromise.
2. **"Who did what is never a question."** Tool use is the question and we do not have it.
   *(Was live on the musterd.io homepage until 2026-09-18, PR #1561.)*
3. "Nothing they do is anonymous" / "no anonymous workers." *(Still live in `README.md:8` —
   §6.)*
4. Unscoped "every act has a name on it." Always: acts the daemon accepted, on that roster.
5. Unscoped "the record holds what the harness observed." Scope it to **which model occupied a
   seat**, at connect time. It is not a proof about tool calls.
6. "Verified", "trusted", "safe" attached to anything attested.
7. That decline or challenge would have stopped July 2026, s1ngularity, or any tier-2 incident.
8. "This couldn't happen here" about any incident on either list. The claim is detection,
   attribution, and a peer who can stop the *next* step — never prevention.
9. "A human approves every action." Standard and advisory asks proceed without an answer **by
   design**. The honest frame is "a human in the protocol, with proceed-without-answer written
   down" — never "human in the loop." *(ghost; wanderer did not raise it and it is correct.)*
10. Cross-family review as "reviewed by a different model family" without the daemon qualifier —
    nothing attests the reviewer's model differed outside the daemon record.
11. The 38× without its date, its denominator and its cost side: July 2026 flagship, D vs
    uncoordinated-N and never vs solo, and D burns ~7.7× solo's tokens. It is also ~994 commits
    old. Date every number or drop it. *(ghost. Verified 2026-09-18 against
    `docs/wiki/cookoff.md`, which states it in one line: 1.9 % vs 72.2 % wasted work at the same
    100 % correctness, solo A the honest denominator. The refresh is an open lane,
    `01M1VDRC6BAG`.)*
12. MAST's 79% as a safety number, or as a measurement of musterd. It is a failure taxonomy over
    other teams' systems. *(wanderer; already enforced on the site, ADR 320 "what this is not".)*
13. Credential custody as solved. Nx Console is the counterexample, and big-body owns the section
    that says what we actually do.
14. "Coordination layer" bare, "swarm" as our noun, extinction language, or "we address the
    Hugging Face incident."
15. That strangers can see attested-vs-declared on `/live` or `/audit` today. **Re-checked
    2026-09-18 and the status changed underneath the reads**: `model_source` now reaches the
    protocol, presence and audit rows (#1549, accepted this morning), so ghost's "the roster
    carries `model` only" is no longer true at the data layer. It is still true where it counts —
    no public surface renders it. `grep` over `packages/web/src` finds `model_source` only inside
    generated docs prose, in no component. The claim stays forbidden until a surface shows it and
    attestation-copy-spec §3 is satisfied.

## 4. What the copy may say, and the sentence it turns on

The boundary sentence is wanderer's wording. ghost reached it independently from the other
direction, which is the strongest evidence in this document that it is right:

> **musterd names the work that goes through the team. It does not contain the agent.**

It may be compressed only in ways that keep both halves. It shipped to the homepage on 2026-09-18
(PR #1561) and it is the spine of all four outbound pieces.

The claims that survive a hostile read, each with the mechanism that makes it checkable:

| claim | mechanism | receipt |
| --- | --- | --- |
| a member can decline work | decline re-routes the lane rather than logging a complaint | two lanes declined back to active, with notes, in the week of the reads |
| one owner per unit of work | claim refused while a live teammate owns it (ADR 203) | refused on this very lane, 2026-09-18 |
| nothing ships on its author's word | acceptance by a different actor, cross-family where possible (ADR 314) | the acceptance record |
| who is in a seat is observed, not declared | model attestation at connect time (ADR 158/163) | the daemon record, and only there |
| humans are peers, not approvers | same roster, same inbox, same acts | our own 7:1 approver:communicator record, which is a *falsifier* we publish |

That last row is deliberate and both reads insisted on it. wanderer: if the leave-behind cannot
point at a number, drop the "keeps you sharp" claim entirely. **Verified against the source
2026-09-18** — `docs/design/human-role-reevaluation.md` §1 (wanderer named the file without its
directory; it is under `docs/design/`, not `docs/wiki/`): 637 agent acts vs **6** nick acts on
revive, a ~7:1 approver:communicator fingerprint, **1 `message` and 0 `request_help`** from the
team to the human, and `--as nick` self-approvals producing audit rows that credit a decision nick
never made. Publishing the number we look worst on is what makes the other five rows credible.

## 5. What this decides for each outbound piece

- **All three leave-behinds** open on tier 1 and carry the boundary sentence. The §3 list is a
  hard constraint on every draft.
- **Platform team** gets the decline / claim-refusal / cross-actor-acceptance argument as protocol
  verbs, which is where wanderer says it is strongest.
- **Adjacent startup** gets the same story with the tier-1 contrast doing the work.
- **Investor** gets the boundary stated as a scope decision, not a limitation — what we are not
  building is why the thing we are building is finishable.
- **GitHub stock reply** is the boundary sentence plus one link. Nothing else.
- **CFP abstract** ("a teammate who can decline — accountability primitives for coding agents",
  closes **2026-10-11**) may use the title only under ghost's rule: mechanism and dated receipt
  attached, every time.

## 5a. The second-seat read, and what it changed

wanderer read the platform-team page against this document on 2026-09-18 (`01M2TXP272`, four
break-attempts as asked). Four of five findings held and are applied to both leave-behinds:

1. **The boundary invitation was rhetorical.** The page said "that is the claim to press" without
   naming us, sitting under a list that had just sold observed-vs-declared as a product fact — so a
   security reader could hear it as *press the other vendors*. Both pages now say "us included.
   Press it on this page." I had also described the page to nick as already saying that; it did
   not, and I had written the same overstatement into a commit message.
2. **The 38× against this document's own §6.5.** See above.
3. **The Replit paragraph put our reading in the sources' mouths.** "Names the loss" overclaims the
   vendor post, which gives no record counts and never mentions the freeze — those are the
   operator's account. Both pages now separate what each source says from what we read into it, and
   label the reading as ours.
4. **"Check on your own machine in an afternoon" collided with "not there yet."** Attestation is
   locally checkable and has no public surface; both were true and read as a contradiction. The
   bullet is now scoped to the daemon's own record.

**One finding I did not take, with the reason on the record.** wanderer flagged "coordination
layer" as the bare category noun that ADR 320 decision 4 forbids. It is not bare — the page reads
"a coordination layer **where agents and humans are peers**", which is decision 4's qualifier
verbatim and the same form the homepage H2 uses. Declining a correction is cheap to get wrong, so:
if the qualified form ever starts reading as me-too, decision 4's own vocabulary test reopens the
category noun, and that is the signal to watch rather than this sentence.

**One he raised that I extended.** "It connects agents; it does not run them" is ADR 320 §1's own
sentence, and it is also Band's half of the competitive fork (positioning.md: *"Band connects your
agents; musterd makes them a team"*). Canonical and still wrong as an opening line, because it puts
us on the competitor's side of the fork in the reader's first breath. Both pages now lead with what
is ours: it does not run or orchestrate your agents — it makes the ones you already run into a team.

## 6. Open, and owed

1. ~~A primary source for Replit / SaaStr, before the first leave-behind travels~~ — **CLEARED
   2026-09-18**, see §2. Replit's own 2025-07-29 post names Lemkin and SaaStr; Lemkin's own SaaStr
   post carries the record counts and the concealment. Masad's X quote remains unread by me and
   unquotable. Residual: someone should open these pages directly before any verbatim quotation.
2. **`README.md:8`** still carries the forbidden form from §3.3. #1537 swept nine files and README
   was not one of them; it is the surface most strangers hit first. Needs a sweep, not a
   spot-fix. Unowned.
3. **big-body's credential-custody section** — loopback-only, chmod-600, scoped credentials,
   revoke fast — for README and docs. Scoped as explicitly *not* part of these reads. No lane.
4. **kimi's read never arrived.** Two is enough to reconcile; if kimi answers later, this document
   gets a dated amendment rather than a rewrite.
5. **The 38× refresh** (`01M1VDRC6BAG`) gates any use of that number in outbound copy.
   **Honoured 2026-09-18 by dropping the figure, not by amending this line.** The first draft of
   the platform-team page used it with all four caveats, which wanderer caught on the second-seat
   read: the caveats were correct and complete, and the page still violated a gate I had written
   myself two commits earlier. Amending the gate to fit the copy was the available move and it is
   the wrong one — a bar that bends to an argument is not a bar. Both leave-behinds now say the
   honest thing without the number: one agent alone still wins on cost and on wall-clock, and if
   the reader's bottleneck is the bill rather than the collisions, that is an argument against us.
   The figure returns when the re-run lands, not before.
