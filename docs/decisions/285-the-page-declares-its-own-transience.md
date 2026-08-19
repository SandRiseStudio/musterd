# 285 — The page declares its own transience

- **Status:** proposed
- **Deciders:** stanley (built increments 1 and 2), miley (accepted #880 and ruled that this record
  was owed), wanderer (independent read on keeping the six guards)
- **Relates to:** ADR 086 (the ambient micro-choreography this now holds), ADR 166 (the sweep series
  whose flake reports started this), ADR 259 (choice-vs-fact — why this is an ADR *and* a wiki
  page), ADR 223 (ADR-number reservation; this ADR is 285 rather than the 282 it was briefed as,
  because 282 was already published)

## Context

`pnpm a11y:check` measures contrast the only way it can be measured honestly: in the browser, on the
pixel actually painted. The sweep settles, freezes rAF, screenshots once, and pairs every text row
with what is beneath it. Every step of that races anything the page is doing on a timer.

`/office-preview` flipped red about **1 run in 3**, always an `lc-speech__text` row, over three
different bits of furniture. The response, over months, was to teach the *instrument* to recognise
motion from outside. `contrast-sweep.mjs` accumulated six exclusion guards, each added after a
specific incident:

| guard | excludes a row that… |
| --- | --- |
| `moved` | changed position between the two readings |
| `born` | appeared after the freeze, stranded at (0,0) |
| `unsettled` | is mid-fade, at an effective opacity below 1 |
| `invisible` | is `display:none` / `visibility:hidden` / opacity 0 |
| `clipped` | is scrolled outside its container's box |
| `covered` | has something painted over it at sample time |

Six guards, and the route still flipped red 1 run in 3. That is the shape of a telescope being
polished when it should be replaced: every guard is a *correct* inference about a page that will not
hold still, and none of them can be right about a page whose motion is unbounded, because the guard
runs at one instant and the motion continues after it.

The thing all six have in common is that they infer from outside what **the page already knows**.
A speech bubble knows it is transient. A carousel knows it is about to advance. Only the instrument
has to guess.

## Decision

**The page declares what is transient, under an explicit measurement mode, and the instrument stops
inferring it.**

`?still` means one thing, and the wording is load-bearing: **the page keeps what it is showing
instead of moving on.** Nothing is hidden, nothing is repositioned, no content is skipped. Every
surface paints exactly what it would otherwise paint. What stops is the page's habit of advancing to
the *next* thing on a timer of its own.

Four consumers honour it, through one shared reader (`packages/web/src/live/stillMode.ts`):

1. **Speech bubbles do not self-dismiss** (increment 1, #880). A bubble dismisses after
   `SPEECH_HOLD_MS + 22ms/char`, and the sweep's settle-and-shoot window straddles that countdown.
2. **The overlay reel does not auto-advance** (increment 2). `DWELL_MS = 6000`, re-arming forever.
3. **The office's ambient scheduler is not armed** (increment 2). ADR 086 Phase 2 idle beats, every
   30–70s, forever.
4. **The asks-strip does not run its 1s countdown tick** (increment 2). Re-rendering `4m 12s` every
   second re-widens a measured row.

### What this is deliberately not

**Not `?quiet`.** That mode already existed and would have been the easy answer: it skips the
choreography entirely. It is the wrong answer because there are then no speech bubbles to measure —
and the speech rows are exactly where the real failures on these routes have been found. A gate that
goes green by removing its subject is worse than a flaky one. **Keep the subject, remove the
motion.**

**Not a replacement for the six guards.** They stay, as **retained backstops** — this is the part of
the decision most at risk of being read as dead code later, so it is recorded here rather than left
in a diff. A future reader will find `moved` and `born` looking redundant now that pages hold still,
and deleting them would be wrong for two reasons: the flag is opt-in and inert everywhere it is not
passed, so every unflagged surface still relies on the guards entirely; and a declaration is a claim
the page makes about itself, which the instrument should still be able to survive being wrong about.
stanley and wanderer independently read keeping them in the same change as correctly conservative,
and that judgement is the record here, not just the diff.

## Consequences

**The MEASURED MID-FLIGHT marker had to be made honest, or retired.** Increment 1 shipped a settle
check that could finally see motion — and `/office-preview` then reported mid-flight on *every* run,
because the room never actually stopped. miley named the risk precisely when accepting #880: a
permanently-qualified green decays into noise, and *a true signal that gets read as noise* is the
same family of failure as a silent wrong green. A marker that is always on is not a marker.

Increment 2 resolved it by holding sources 2–4 above, and by one further correction: with the
re-arming timers held, the room genuinely stops — at **~22s**, against a `SETTLE_CAP` of **20s**.
The gate was giving up under two seconds before the page it was measuring stopped moving. The cap is
now 30s, which is close to free: a page that settles returns the instant it settles, so the cap is
only ever paid by a page that never settles at all.

**A route can silently opt out of a global motion policy.** The ambient scheduler already stood down
under `prefers-reduced-motion`, which the sweep emulates — so it *looked* covered. It was not:
`/office-preview` mounts the scene with `reduced: false` hardcoded, so on the single route the
contrast gate leans on hardest, the one motion source everyone assumed was disabled was running. An
identity-keeping probe watched that room sit perfectly still for 115 seconds and start walking again
at 137s. The general lesson is worth more than the fix: **"it's disabled under reduced motion" is a
claim about a call site, not about a module**, and it has to be checked at the call site.

**Measurement modes need one reader.** Before this there were two private copies of the URL parse
and two more were about to be written. `isStill()` is one pure function over a search string, unit
tested — including against `?stillwater` and `?distill`, because a substring test would turn
measurement mode on for a page somebody was trying to watch move.

**What the flag cannot do.** `?still` holds timers the page owns. It cannot hold a live server
pushing envelopes, which is why connected `/live` is a separate problem and not simply the same flag
passed to another route.

## Alternatives considered

**Raise the settle cap and change nothing else.** Rejected as the *primary* fix: with the reel and
the ambient scheduler re-arming forever, no cap is large enough — the page's motion is unbounded,
so this only buys a longer wait before the same verdict. It became a *secondary* fix once the
unbounded sources were held and the remaining gap was a bounded 22s choreography against a 20s cap.

**Emit the preview script on its own 6.7s timeline rather than as one burst at mount.** Tested,
measured, rejected: quiescence was **21.6s bursting and 22.5s staggered**. The theory was that seven
simultaneous walks contend for the floor and take longer to drain; they do not. The ~22s is the
choreography's own length, not an artifact of the emit shape. Recorded in the code comment as well
as here, so the next person does not re-run the experiment.

**Fold geometry into the polled settle key set.** Tried during increment 1 and rejected on
measurement: sampling geometry every poll forces a layout per poll, which starved the office scene's
rAF loop badly enough that its canvas never finished painting inside the cap — the sweep then
refused the whole route, turning a stillness check into a harness failure. Raising the cap to 60s
let it through, which is the proof it was starvation and not breakage. Geometry is therefore the
*verification*, not the signal: the cheap key set settles first, and only then are two snapshots
compared. That is a trap rather than a choice, so per ADR 259 it is written up as a wiki page —
[docs/wiki/measuring-a-moving-page.md](../wiki/measuring-a-moving-page.md) — next to
`running-the-gates.md`, where someone debugging a gate will actually hit it.

## Evidence

Measured 2026-08-19 on `/office-preview?light=12&still`, with a probe that keeps element identity
(`GEOM_IN_PAGE` sorts positions and joins them, so it can prove motion but name nothing), sampling on
the sweep's own beat under the same emulated reduced-motion:

- **Overlay reel:** rotation boundaries at 6223 / 12176 / 18245 / 24314 / 30389 / 36203 / 42281 /
  48351 / 54425 ms — a flat 6s period, forever. Past the 30s mark of a 150s run, **144 of the 214
  remaining DOM events were the reel's**.
- **Ambient beats:** room still from 21.7s to 137.0s, then a walk starts — 115 seconds of stillness
  is not quiescence when a scheduler is still armed.
- **Script walks:** drain at ~22s. Bounded, and the subject being measured, so not held.
- **After:** `/office-preview` 40 rows measured at both lights, MID-FLIGHT gone, 0 below AA; full
  gate green.

**Falsifier:** run `pnpm a11y:check --routes /office-preview` on a build of #891 or later. If
`MEASURED MID-FLIGHT` appears on a green run, this decision has not held and something new is
re-arming — find it with an identity-keeping probe before adding a seventh guard.

## Observability & Evaluation

**Traces.** The instrument already reports its own state and needs no new emission: `contrast-gate.mjs`
prints `MEASURED MID-FLIGHT` per route whenever `settle.how !== 'settled'`, and `--json` writes the
full `settle` record (`how`, `ms`, `painted`) alongside `transient`, `liveFails` and `probeFails`.
That is the signal this ADR is accountable to, and it is per-route and per-run.

**Eval.** *Dataset:* the nine routes the gate sweeps, at both light values, over ten consecutive
runs — the same shape as the flake measurement in #880, which is what makes the before/after
comparable. *Baseline (measured 2026-08-17, #880):* `/office-preview` reported `MEASURED MID-FLIGHT`
on **10 of 10** runs, at 19–20 rows before the settle fix and 39–40 after it. *Now (2026-08-19,
#891):* mid-flight on **0 of 2** gate runs at 40 rows both lights, full gate 9 routes 0 below AA.
*Pre-registered pass condition:* over ten consecutive gate runs on landed main, `/office-preview`
reports mid-flight **0 times** and measures ≥ 39 rows at both lights. Anything above zero means a
timer is re-arming and the marker is drifting back toward noise.

**Experiment.** The one this ADR pre-registers is the *negative* case, because the failure mode here
is a marker that stops meaning anything rather than one that goes wrong loudly. Introduce a
deliberate unbounded timer on a swept route behind a temporary flag, run the gate, and confirm it
reports `MEASURED MID-FLIGHT`. If a page with a known forever-timer measures as `settled`, the
settle check has regressed to the pre-#880 blindness (a stable key set over a moving page) and the
guards are back to being the only thing holding the gate up.

**What would retire this decision.** If a future measurement shows unflagged routes settling on
their own — i.e. the six guards never firing across a full sweep series — then the declaration is
carrying no weight the page did not already carry, and `?still` should be reconsidered rather than
extended. That is the honest exit, and it is not the situation today: the flag is inert on every
route that does not pass it, and the guards fire on those.
