# Measuring a moving page

Everything the contrast gate does — settle, freeze, screenshot, sample the pixel — is a race against anything the page is doing on a timer, and the traps below cost multiple lanes each before they were written down.

## Polling geometry starves the thing you are waiting for (2026-08-17, #880; falsify: set `A11Y_SETTLE_CAP=60000` and watch the same route pass)

The sweep's settle detector polls a key set (`class|ink|paper`) until two consecutive samples match. That key set **could not see motion at all** (2026-08-17, fixed in #880; falsify: read `KEYS_IN_PAGE` and `GEOM_IN_PAGE` in `contrast-sweep.mjs`): a character walking across the office carries its label and its bubble with it while every key stays identical, so the sweep concluded "settled" and shot mid-walk.

The obvious fix — fold each row's position into the polled key set — is the trap. Sampling geometry every poll forces a **layout per poll**, and that starved the office scene's rAF loop badly enough that its canvas never finished painting inside the 20s cap. The sweep then refused the whole route with "a canvas under measurable text never painted", i.e. **a stillness check turned itself into a harness failure**. Raising the cap to 60s let the same code through unchanged, which is the proof it was starvation and not breakage.

What works instead: **geometry is the verification, not the signal.** The cheap key set polls; once keys are stable *and* the canvas has painted, take exactly two geometry snapshots `GEOM_STEP` apart and compare. Two layouts per run, not one per poll.

If you are tempted to re-try the per-poll version, the tell that you are in this trap is a route that fails with a *paint* complaint rather than a *contrast* one, and passes as soon as the cap goes up.

## `GEOM_IN_PAGE` can prove motion but cannot name it (2026-08-19; falsify: read the `out.sort().join('|')` at the end of it)

It collects `x,y` per row, **sorts**, and joins. So a difference between two snapshots means "something moved" and nothing more — no element, no class, no text. Debugging "what is still moving?" with the sweep's own output is therefore impossible by construction.

Use a probe that keeps identity: same walker, same filter, same emulated `prefers-reduced-motion`, but record `tag.class`, a text head, and the box, then diff consecutive samples and print what changed. Doing that turned a day of guessing into three named sources in one 150s run. Two consequences of the sort are worth knowing: a row moving into a position another row vacated can cancel out and read as settled, and the same collapse hides which of several identical-looking rows is the culprit.

## "It's disabled under reduced motion" is a claim about a call site, not a module (2026-08-19; falsify: `grep -n "mountOffice(" packages/web/src/`)

The office's ambient scheduler (ADR 086 Phase 2 idle beats, every 30–70s, forever) correctly stands down under `prefers-reduced-motion`, and the sweep emulates `reduce`. In-page, `matchMedia('(prefers-reduced-motion: reduce)').matches` returned `true`. Everything said it was covered.

It was not. The scene takes `reduced` as a **parameter**, and `packages/web/src/routes/office-preview.tsx` mounts it with `false` hardcoded — so on the one route the contrast gate leans on hardest, the motion source everyone assumed was off was running. The probe watched that room sit perfectly still for 115 seconds and start walking again at 137s.

The general form: when a module gates behaviour on a flag it *receives*, verifying the flag's global value proves nothing. Check what each call site passes. (Here, `/live`'s `OfficeScene.tsx` passes a real value and `/office-preview` does not — same module, opposite behaviour.)

## One re-arming timer is enough to make a page that never settles (2026-08-19, #891; falsify: `pnpm a11y:check --routes /office-preview` on #891 or later)

Motion sources are not additive in their effect — they are a max. A page settles only when **every** self-re-arming timer has stopped, so the smallest forever-timer sets the floor. `/office-preview` had three sources; the two that mattered were the ones with no end:

- the overlay reel, `DWELL_MS = 6000`, rotating forever — past the 30s mark of a 150s run, 144 of the 214 remaining DOM events were its;
- the ambient scheduler above, every 30–70s, forever.

The script's own walks drain at ~22s and were deliberately left alone: they are the subject being measured, and holding them would freeze the room half-assembled.

The fix is the page declaring its own transience under `?still` ([ADR 285](../decisions/285-the-page-declares-its-own-transience.md)) — the page keeps what it is showing instead of moving on. When you add a new timer to a measured surface, it needs to answer to that flag, or this page gets a fourth bullet.

## The cap must exceed the route's own choreography (2026-08-19, #891; falsify: `A11Y_SETTLE_CAP=20000 pnpm a11y:check --routes /office-preview`)

With the unbounded sources held, `/office-preview` genuinely stops — at **~22s**, against a `SETTLE_CAP` of **20s**. The gate was giving up under two seconds before the page stopped moving, and reported `MEASURED MID-FLIGHT` about a room that does in fact settle. The cap is now 30s.

Raising it is close to free, and knowing why matters: a page that settles returns **the instant it settles**, so the cap is only ever paid by a page that never settles at all. The cost of a generous cap is bounded by the number of genuinely-broken routes; the cost of a tight one is a permanently-lit marker on a good page.

Rejected on measurement while chasing the same number: emitting the preview script on its own 6.7s timeline instead of as one burst at mount, on the theory that seven simultaneous walks contend. Quiescence was **21.6s bursting, 22.5s staggered** — the ~22s is the choreography's own length. Don't re-run it.

## A permanently-lit marker is a broken marker (2026-08-19; falsify: read the `settle.how !== 'settled'` branch in `contrast-sweep.mjs`)

`MEASURED MID-FLIGHT` is a real, hard-won signal: the settle check finally seeing motion is what #880 bought. But it fired on **every single run** of `/office-preview` for two days, because the room never stopped — and a qualifier that is always present is one nobody reads. "A true signal that gets read as noise" is the same family of failure as a silent wrong green, and it is the reason the residual motion had to be held rather than documented and accepted.

When a new honesty marker starts firing constantly, that is not the marker working. Fix what it is pointing at, or the next reader learns to skip the line.
