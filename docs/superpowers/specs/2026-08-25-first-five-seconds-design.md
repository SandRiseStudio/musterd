# The first five seconds — a stranger can tell what they are watching

**Date:** 2026-08-25 · **Author:** miley, from a design conversation with nick
**Status:** spec for review — implementation lanes follow the rollout order in §6
**Lane:** 01M0GVP2DP (Delight B, goal office-delight) · absorbs A3 (01M0TSWH78)

## 1. The problem

There is no legend anywhere in the UI (verified 2026-08-20). A stranger arriving mid-stream sees
isometric figures walking between desks with speech bubbles, and has no way to learn what a lane
is, who the agents are, whether they are real, or why any of it is happening. Increment A was
per-element clarity; B is orientation. The hard case is `/broadcast`: no hover, no click, arrival
at an arbitrary moment of a 720p25 stream.

**Principle (nick, 2026-08-24):** one mechanism that works on both surfaces, everything transient —
open real estate is preserved; nothing new is permanently parked on the frame.

**Bar / falsifier:** show a cold viewer ~10 seconds of the stream. They should be able to say, in
their own words, what they are looking at. If they cannot, the increment failed regardless of how
polished its parts are.

## 2. Caption rail — orientation through narration of real moments

A transient lower-third caption on both surfaces, riding the existing overlay capsule slot
(`OfficeOverlay`). A stranger learns the vocabulary by watching it used on events that are actually
happening — the caption and the choreography it names are on screen together.

- **What earns a caption: notable moments only** — the acts that already get choreography:
  handoff walks, accepts (the confetti moment), steers, asks directed at a human, a member
  arriving or leaving. Status chatter never captions.
- **Register: full plain sentences, present tense, names first.** "ryder just handed work to
  dolly" · "dolly accepted — the work is done" · "izzo is asking nick to approve something" ·
  "sloane just signed off for the night". No wire tokens, no title-cased jargon.
- **Discipline:** one caption at a time, ~6 s hold, at most 2 queued — past that, drop rather
  than narrate the past. A caption whose animation already ended is noise, not orientation.
- **Stream-safe by construction:** text in the capsule's existing type (≥13 px pre-encode at
  stream scale), no new motion — appear/dissolve uses the capsule's existing transition, so
  reduced-motion parity is inherited, and 25fps capture has nothing new to judder.

## 3. One vocabulary — A3 closes inside B

The captions and the speech bubbles speak the same language, so the room never contradicts its own
narrator. `stripNoise` finishes the job it started:

- No `[lane]` / `[goal]` envelope and no bare wire verb ever reaches a bubble. One shared
  verb map serves bubbles and captions: `resolved` → "finished", `handoff` → "handing this to
  you", `awaiting_acceptance` → "ready for review", `request_help` → "asking for help", and so
  on — the map is the single place the translation lives.
- Bubbles stay the member's own words where the body is prose; the translation applies to the
  envelope and act tokens around them, not to what a member actually wrote.
- Lane A3 (01M0TSWH78, "the envelope reads as a log line") is absorbed: its scope is exactly this
  section. It gets closed into B on the board when this lands.

## 4. The receptionist welcome — who and what, in fiction

The one place a full explanation is allowed, delivered by the character whose job it is. Her
existing mode machine (`asleep / waking / idle / greeting / typing / call`) gains a **welcome
sequence** — three beats, one bubble each, honest and warm:

1. "welcome to the office"
2. "everyone here is a real agent or human on one team, working right now"
3. "the bubbles are their actual messages"

- **/live:** plays once per visitor on arrival; remembered in `localStorage` so a returning
  viewer is not re-greeted (wrapped in try/catch; absence of storage degrades to greeting again).
- **/broadcast:** replays every ~20 minutes (nick's number), as if greeting the stream — a
  mid-stream stranger is at most 20 minutes from the full answer, and captions carry them until
  then.
- Beat timing uses the existing speech-bubble hold rules; the sequence yields instantly to any
  real choreography (ADR 086: ambient never delays real work) and simply resumes at the next
  scheduled slot rather than queueing.
- The three lines are brand voice on a public surface — sloane reviews the final copy before it
  ships (her lane-claim not required; a directed message with the strings is enough).

## 5. Bytes and constraints

- Everything rides existing machinery: the overlay capsule, the speech-bubble renderer, the
  receptionist mode machine. Estimate **≤1.5 KB JS gzip** (verb map + caption scheduling +
  welcome sequence) and **~0.2 KB app CSS**, against measured headroom of ~1.7 KB total JS and
  ~2.4 KB app CSS (2026-08-25 build). Caption logic lives in the office-scene/live chunk, never
  the entry — initial JS is the tight budget (151.9/152.3).
- No new rAF, no new interval on `/live` beyond the broadcast welcome timer, which suspends with
  the scene's existing visibility suspension.
- `pnpm perf:check` runs after a fresh build in the same breath (the stale-dist trap, paid
  2026-08-24).

## 6. Rollout

1. **Lane B1 — one vocabulary + caption rail** (§2–§3). Web only. Closes A3; the board lane
   01M0TSWH78 is resolved into this landing.
2. **Lane B2 — receptionist welcome** (§4). Web only. Copy reviewed by sloane before merge.

Order matters: the captions are the workhorse and the welcome refers to a room the captions are
already explaining.

## 7. Non-goals

- No persistent legend, chrome, or corner card — transience is a stated principle, not a budget
  accident.
- No station ident / periodic branded overlay (considered 2026-08-25, not chosen; revisit only
  with new evidence that captions + welcome leave strangers lost).
- No arrival card on `/live` (subsumed by the receptionist, who is better at the same job).
- No sound (E2 owns work-tracking sound; it is unspecced).

## 8. Open questions (settle in implementation)

- The exact verb map — enumerate every act/lane-state token during B1 and let the tests pin the
  full set, so no token can fall through to machine syntax silently.
- Whether the broadcast welcome timer should skip when the room is mid-choreography burst (likely
  yes: the yield rule in §4 gives this for free).
