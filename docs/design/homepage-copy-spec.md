# Home page — UI-copy spec for showing the product instead of describing it

Lane `01M2NS50HC91XPYNBXG4QK3T2T`. Opened by miley as the designer on nick's steer, handed to
sloane (product-communications) on 2026-09-18 because the copy and the section order are this
role's call. miley's half is layout and the visual system; every string below is mine.

Companion to [watch-page-copy-spec.md](./watch-page-copy-spec.md). That spec's §2 rule governs
this page too and is not restated in full here — read it first.

## 1. Why this page changes

Three things, in descending order of how badly they need fixing.

**The page makes a claim two independent security reads told us to stop making.** The fourth
what-is card is headed **"Who did what is never a question"** and its body ends "it makes sure
nothing on the roster is anonymous". Both are the #1537 defect — a containment promise wearing
attribution's clothes — in the two places #1537 did not reach. #1537 scoped the card's *first
sentence* on 2026-09-16 and left the heading and the tail standing, so the page currently scopes
the claim in the middle of a card that overclaims at both ends. wanderer (grok-4.6, act
`01M2RDQYCG`) and ghost (muse-spark-1.3, act `01M2RNPSF2`) each named this sentence family
unprompted, on separate days, without having read this page: a stranger hears "act" as *every
action*, and July 2026 was thousands of actions that were not Acts.

**The page asserts LIVE when it does not know.** The prerendered HTML of `/` and `/watch` both
ship a player facade carrying a `LIVE` badge and the label `live broadcast`, unconditionally,
before any player loads. `/watch` reads real liveness for its eyebrow and state line — the rule in
watch-page-copy-spec §4.1 — and then contradicts it one element over. On a dark channel a
stranger's first impression of this project is a badge that says LIVE over nothing.

**The office appears on no page of this site.** The homepage's only image is the Twitch embed,
which between sessions is a black rectangle with a play triangle. The office — a real isometric
floor where named agents and humans sit at labelled desks — is the most distinctive thing this
product has, and `office-still.png` has been in the tree since #1474 doing nothing but serving as
`/watch`'s share card. We own the proof and show it to no one who does not unfurl a link.

### What is NOT a reason, and two premises that expired

miley's readout is dated 2026-09-16 18:50Z and two of its secondary findings have since been
overtaken. Recorded so the next reader does not chase them:

- ~~"How priorities are decided" puts a bare "about 79% of multi-agent failures" in front of a
  stranger~~ — **cut 2026-09-16 on nick's call**, under this same lane. `WEDGE` survives only in
  `content/site.ts` where `gen-roadmap` renders it into ROADMAP.md, which is the right reader.
  Verified absent from the live HTML 2026-09-18.
- ~~"The three feature cards"~~ — there are **four**; the fourth landed 2026-09-16 under ADR 320
  decision 5.
- ~~"www.musterd.io does not resolve"~~ — it resolves and 301s to the apex, 200. Verified
  2026-09-18. Not this lane's to fix and no longer anyone's.

**No conversion argument is made anywhere in this spec, and none may be added.** miley put the
caveat on the record at open and it stands: this site has had essentially no traffic ever and was
not indexed until 2026-09-16. "Show the product rather than describe it" is true at zero visitors.
"This ordering converts better" is not knowable here and is not claimed.

## 2. The added rule, on top of watch-page-copy-spec §2

**A claim about naming must carry its scope in the same breath, in every position it appears —
heading, body, alt text and caption alike.** #1537 established the scoped forms; this page is the
evidence that scoping a body sentence and leaving the heading is not a fix, because the heading is
what a scanner reads and the body is what they skip.

The canonical scoped statement (ADR 320 §5a, #1537) is **"every act on the roster has a name on
it"**. The boundary sentence is wanderer's, which ghost reached independently: **musterd names the
work that goes through the team; it does not contain the agent.** Either may be compressed only
in ways that keep both halves.

Forbidden on this page, now and later:

- "Who did what is never a question" — tool use is the question, and we do not have it.
- "nothing on the roster is anonymous" / "no anonymous workers" as a standalone claim.
- Any unscoped "every act", "every action", or "the record holds everything".
- "the record holds what the harness observed" without naming *what* was observed. The harness
  attests **which model occupied a seat**, at connect time. It is not a proof about tool calls.
- "verified", "trusted", "safe" attached to anything attested (attestation-copy-spec §2).
- A state word — "live", "now", "currently" — in any string the prerendered HTML ships, unless it
  is true in both the live and dark states.

## 3. Section order

> **SUPERSEDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md)** (lane
> `01M32GK3SZ`). The order below shipped and was measured at 390×844 on a live channel: the still
> and the player fitted in one viewport 418px apart, so the page rendered the same room twice.
> There is now ONE office and it is the stream. The live order is:
>
> ```
> SiteNav → LightHero → StreamSection → WhatIs → GetStarted → Teasers → SiteFooter
> ```
>
> The paragraph below about the hero keeping the first screen is unchanged and still governs.

~~One insertion and nothing else moves:~~

```
SiteNav → LightHero → OfficeProof (new) → StreamSection → WhatIs → GetStarted → Teasers → SiteFooter
```

The hero keeps the first screen. It is type on the mustard ground with the install command in it,
it works, and the measured reason not to put the office above the fold is that the install command
is the one thing on this page with a job. The office is the first thing *below* the fold, which is
where a reader who did not install goes looking for a reason to.

## 4. The page, top to bottom

### 4.1 Hero — unchanged

No string changes. Stated here so a reviewer diffing the page knows the omission is deliberate.
`LightHero`'s sub already carries the scoped form from #1537 ("Every act on that roster has a name
on it, and a human is on it too") and `landing.test.ts` pins it.

### 4.2 The office — new section

> **SUPERSEDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md).**
> `OfficeProof` is deleted. Everything below that was load-bearing moved into `StreamSection` and
> is still enforced — the two closing sentences, the imported alt, the static capture over the live
> canvas — by `landing.test.ts` and `streamSection.test.ts`. What did NOT survive: this section's
> H2, and the caption, which is now state-dependent because the section can read liveness. The
> record below is kept for the reasoning, not as instructions.

H2: `The team that builds musterd`

Body, one paragraph:

> Every member has a desk with their name on it — the agents on the roster and the humans who work
> with them. A desk outlasts the session that filled it: close the harness window and the member,
> their inbox and their unfinished work are all still there. This is our team. Yours is what
> `npx @musterd/cli init` starts.

The last two sentences are load-bearing and may not be cut. ADR 320 §1 is that musterd connects
agents and does not run them, and watch-page-copy-spec §2's first corollary is that a picture of
our office reads as "a virtual office for your agents" unless the copy says whose office it is and
hands off to the product. The picture makes that failure *more* likely here than on `/watch`,
because the homepage reader has not yet been told what they are looking at.

Caption, set small, directly under the image:

> A still from the stream. The office is live while the team is working.

This is the §2 state rule doing its job: the sentence is true whether the channel is live or dark,
it tells the reader the image is not a live view, and it invents no schedule.

Link, under the caption: `Watch them work →` to `/watch`.

Alt text: **exactly** `WATCH_COPY.stillAlt`, which is already written, already shipping, and
already reviewed — *"The musterd office view: named agents and humans at desks on one floor, each
desk labelled with the member's name, coloured badges showing what each is doing."* Import it;
do not retype it.

### 4.3 The stream section — facade strings only

H2, body and links unchanged. The two facade strings change:

| element | was | becomes |
|---|---|---|
| badge | `LIVE` | *removed* |
| label | `live broadcast` | `musterd on Twitch` |

The play triangle stays: it is a player affordance, not a claim about state. The badge goes rather
than becoming neutral because a state badge that cannot read state has nothing to say, and a
greyed one invites the reader to decide what grey means.

**The identical change applies to `/watch`'s facade**, which carries the same two strings and the
same defect. It is in this lane because it is the same sentence and splitting it would ship the
fix to one of the two pages that has it.

### 4.4 What musterd is — the fourth card

H2 and the first three cards unchanged. The fourth card, both ends:

| | was | becomes |
|---|---|---|
| heading | `Who did what is never a question` | `Every act on the roster has a name on it` |

Body:

> Who occupies a seat is what the harness observed, not what the agent declared. A member can
> decline work and challenge a claim, and nothing ships on its author's word — acceptance comes
> from someone else. musterd does not sandbox your agents; your own host, sandbox and provider
> controls still do that. It names the work that goes through the team.

Three changes from the current body, each with a reason:

1. The old first clause ("Every act on the roster names its member") is **promoted to the
   heading**, so the scope travels with the scanner rather than with the reader who finished the
   card. `landing.test.ts:40` pins the old string and must be updated to the new position.
2. "the record holds what the harness observed" becomes "**who occupies a seat** is what the
   harness observed". Both security reads flagged the unscoped form as the page's weakest
   sentence: a reader hears a tool-call transcript, and what we have is model identity at connect
   time (ADR 158/163).
3. The tail "it makes sure nothing on the roster is anonymous" becomes "**it names the work that
   goes through the team**" — the §2 boundary sentence. The disclaimer that precedes it is kept
   verbatim, including "still do that" (`landing.test.ts` pins it, and #1537 added it because a
   bare "we do not sandbox" reads as evasion), and is promoted from an em-dash aside to its own
   sentence, because it is the half a security reader is checking for.

### 4.5 Get started, Teasers, Footer — unchanged

## 5. The office still

> **AMENDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md).** The still
> survives — the reasoning below is exactly why it had to — but it is no longer a figure in its own
> section. It is the stream slot's OFFLINE state, stacked on the player and shown whenever liveness
> is not `live`. Two details below are now inverted by the move above the fold: it is eager with
> `fetchPriority="high"`, not `loading="lazy"`.

**Ship the existing asset.** `packages/web/src/brand/office-still.png`, 1200×630, 166 KB, in the
tree since #1474. It is a real capture: five labelled desks (`nick`, `miley`, `sloane`, `izzo`,
`stanley`), model badges, the MON–FRI 11am–3pm sign, the mustard chip. Using it costs the image
bytes and nothing else — no scene bundle, no rAF, no eager-graph entry.

**Motion is settled and the answer is no.** miley measured the scene on the GPU-less bench box
(performance-4x) on 2026-09-18, lane `01M2TM6C6XF6`, status_update `01M2TQ0036`: **~51 ms per
draw, of which ~34 ms is Skia per-op cost that clipping does not remove.** A live canvas on a
public marketing page would charge that to every visitor without a GPU. A still is not this page's
fallback; it is its honest default. A short looping capture stays available as an upgrade — it is
bytes, not frames, and never touches a visitor's CPU — but it is not required to ship this.

**What the current asset is not good enough at**, stated so a purpose-made capture has a brief and
so nobody mistakes reuse for endorsement:

- It is cropped 1200×630 for a share card, so the room sits small inside a lot of empty gradient.
  On-page it wants a tighter crop on the floor.
- Its roster is a 2026-09-16 snapshot in which nearly every badge reads `opus`. That quietly
  undersells cross-family review, which is one of the few claims in §2 that survives a security
  reader. A replacement capture should catch a roster with visible model variety.
- Most desks are empty. True, and not flattering. A capture taken mid-session with more members
  present is a better picture of the same honest thing.

None of the three blocks shipping. A capture is this role's to take (watch-page-copy-spec §7) and
is a follow-up, not a dependency.

## 6. Acceptance criteria for the implementation lane

1. Every string on the page is in this spec character for character, or is explicitly marked
   unchanged in §4. Reviewer diffs rendered text, not source.
2. `grep` of the built home HTML returns **zero** hits for `Who did what`, `never a question`,
   `nothing on the roster is anonymous`, and — in the prerendered markup of both `/` and
   `/watch` — `LIVE` and `live broadcast`.
3. `landing.test.ts` pins the new fourth-card heading and the new body's scoped clause, and its
   old assertion at line 40 is moved rather than deleted — a dropped assertion is how this defect
   survived #1537.
4. A test asserts the office section renders the still with `WATCH_COPY.stillAlt` as its `alt`,
   imported and not retyped.
5. `pnpm perf:check` green with no budget raised. The image is below the fold: it carries
   `loading="lazy"`, `decoding="async"` and explicit `width`/`height` so it cannot shift layout.
6. `pnpm a11y:check` green, including the caption at its small size — it is the string on this
   page most likely to fail contrast.
7. `pnpm vocab:check` green (ADR 296: not "room", not "swarm", not "session" for Presence).
8. Confirmed on the deployed site, not the build: the page is a deploy, and ADR 308 makes landed
   and live different facts. miley deploys; a reviewer opens musterd.io and reads the fourth card.

## 7. Non-goals

- **The four cards' form is not changed here.** miley's read is that the content is the best
  writing on the site in the one shape that reads as generated, and she is right that `/watch`'s
  definition-list treatment is better. That is a visual-system change on her surface, wider than
  this lane, and doing it in the same PR as a claim correction would make both harder to review.
  Recorded as a follow-up, with the reasoning, so it is not rediscovered.
- No h1 resize. miley flagged it as set at documentation scale for 1440; it is hers to judge and
  it is not copy.
- No live canvas, no roster fetch, no daemon dependency on this origin (ADR 132/156).
- No conversion claim, no A/B, no published schedule.
- No change to `/live`, `/broadcast`, or the office scene itself.

## 8. Follow-ups this lane found and deliberately did not take

- **README.md still carries the unscoped form.** Line 8: *"Every act carries a member's name … there
  are no anonymous workers on a musterd team."* #1537 swept nine files and README was not among
  them. It is the same defect as §1's, on the surface most strangers actually hit first. Outside
  this lane's scope; needs its own, and it should sweep rather than spot-fix.
- The four-card form, per §7.
- A purpose-made office capture, per §5.
