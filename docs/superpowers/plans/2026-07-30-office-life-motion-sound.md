# Office Life — Dog Volume and Room Sound Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. On this machine
> subagent-driven execution is disabled — musterd is the coordination layer. Implement inline in your
> own seat, or hand a task to another seat with `team_send {act:'handoff'}`.

**Goal:** Give the dog mass so it stops reading as paper through a turn, and make the room sound like
it has people in it — quieter, more convincing typing plus a real vocabulary of small noises.

**Architecture:** Two independent halves. The dog is pure painter work in `office-scene/render.ts`.
The sound is `src/live/sound.ts`, extending the existing three-layer room tone (AIR / HUM / LIFE) —
every new event rides the existing `lifeBus` and its `LIFE_GAIN` makeup, and the chatter gate takes a
thin one-way occupancy summary pushed *from* the scene so `sound.ts` stays independently testable.

**Tech Stack:** TypeScript, Canvas 2D, WebAudio, Vitest.

**Spec:** [2026-07-30 office life, motion & sound](../specs/2026-07-30-office-life-motion-sound-design.md)

## Global Constraints

- **All new audio rides `lifeBus`.** Per-event gains stay *relative* to each other; the layer's
  absolute level is the single `LIFE_GAIN` number. **Never scatter makeup factors through five
  synths** — that rule is written into `sound.ts` and it is there because this layer shipped
  inaudible once.
- **Measurement resolution is ±3 dB.** Each render draws fresh random noise. Do not tune finer.
  Reference peaks against a −33.7 dBFS bed: keystroke −25, murmur −25, chime −30, mug −30, creak −31.
- **No audio assets.** Synthesis only (perf contract).
- **Nothing schedules while `document.hidden`.** New events go through the existing `armLife` /
  visibility path — no new timers.
- **Jitter every parameter per play.** A predictable loop gets switched off within the hour.
- **Do not touch `pawCycle` or the derived-reach gait** — shipped fix (#483). Never re-add per-leg
  `easeInOut`.
- **Tests run from the repo root only:** `pnpm vitest run <path>`.
- **Visual check:** `vite preview` + CDP, never `vite dev`. Restart preview after every build.
- Commit after every task. Branch: `feat/office-presence-chrome`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/web/src/live/office-scene/render.ts` | dog painters | torso volume, crossfade window |
| `packages/web/src/live/office-scene/pet.test.ts` | dog assertions | volume + crossfade tests |
| `packages/web/src/live/sound.ts` | room tone + cues | typing rebuild, new events, gates |
| `packages/web/src/live/sound.test.ts` | **new** | event roll, gates, determinism |
| `packages/web/src/live/office-scene/index.ts` | scene → sound | push occupancy summary |

---

# Part 1 · The dog

## Task 1: Diagnose before you build

**Read this before writing code.** The obvious fixes are already in the tree, and re-doing them
wastes the session:

- Far-side legs already have their own shade (`DOG.furFar`) and are drawn behind the torso.
- The stride bob, the lagging tail, and the shadow that breathes with the gait already exist.
- The sliver problem was already found once (nick, 2026-07-29, *"extremely thin, like a piece of
  paper"*) and partly fixed with a crossfade to a chest-on view:

  ```ts
  const towardness = Math.min(1, Math.max(0, (0.55 - Math.abs(pet.face)) / 0.2));
  if (pet.mode === 'walk' && towardness > 0) drawDogFacing(ctx, p, s, pet, t, towardness);
  ```

So the facing view covers `|face| < 0.55`. **The remaining paper band is `|face|` between 1.0 and
0.55**: the profile is squashed to as little as 55% of its width, there is no facing view yet, and
the torso is a flat fill. A flat shape squashed on one axis is geometrically a sheet of paper turning
edge-on — and that is exactly the band a walking dog spends most of its turn in.

Two levers, in order of value:

1. **Torso volume shading** — works at *every* facing, including full profile. Biggest lever, because
   a shape with no internal value change reads as a cutout no matter how well it is animated.
2. **Start the crossfade earlier** — shrink the unshaded squash band.

- [ ] **Step 1: Confirm the band by eye**

Build, restart preview, open `/office-preview`, and watch the dog **turn** — not walk in a straight
line. The straight-line walk already looks fine; that is why this is still open.

```bash
pnpm --filter @musterd/web build && pnpm --filter @musterd/web preview
```

## Task 2: Give the torso volume

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`drawDog`, the walk-case body block ~1998)
- Test: `packages/web/src/live/office-scene/pet.test.ts`

**Interfaces:**
- Produces: `DOG.furLit` and `DOG.furShade` on the existing `DOG` palette const.

- [ ] **Step 1: Write the failing test**

```ts
describe('the dog has mass', () => {
  it('shades the torso in three values — a flat fill reads as a cutout at any facing', () => {
    expect(DOG.furLit).toBeDefined();
    expect(DOG.furShade).toBeDefined();
    expect(new Set([DOG.fur, DOG.furLit, DOG.furShade]).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/pet.test.ts
```

Expected: FAIL — `DOG.furLit` is undefined.

- [ ] **Step 3: Add the tones**

```ts
const DOG = {
  …
  /** Top-lit spine and shaded belly. The single largest 2D→3D lever available on a flat fill: it
   *  costs nothing at any facing, and unlike the crossfade it also works in full profile, where the
   *  animal is widest and the flatness is most visible. */
  furLit: mul(/* existing fur */ '…', 1.09),
  furShade: dim(/* existing fur */ '…', 0.88),
};
```

- [ ] **Step 4: Paint the volume**

In the walk-case body block, after the barrel is filled, add in this order:

1. A **lit band along the spine** in `DOG.furLit` — an ellipse or quad hugging the top edge.
2. A **shaded belly** in `DOG.furShade` along the bottom edge.
3. **Shoulder and haunch masses** — two overlapping forms in a slightly different tone from the
   barrel between them. This is the standard illustrator's fake for a rib cage, and it also gives the
   legs something to attach to, which is part of why they currently read as sticks under a shape.

- [ ] **Step 5: Run the test and look at it**

```bash
pnpm vitest run packages/web/src/live/office-scene/pet.test.ts
```

Build, restart preview, watch a turn. The dog should read as an animal with a rib cage.

- [ ] **Step 6: Commit**

```bash
git commit -am "Give the dog's torso volume: lit spine, shaded belly, shoulder and haunch mass."
```

## Task 3: Widen the crossfade and floor the body depth

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts:1910-1911`, and the `m` clamp ~1781
- Test: `packages/web/src/live/office-scene/pet.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('the turn never shows a bare squashed billboard', () => {
  it('starts the chest-on crossfade before the profile squashes past half width', () => {
    expect(towardnessFor(0.7)).toBeGreaterThan(0);
  });

  it('is fully chest-on well before the degenerate-matrix floor', () => {
    expect(towardnessFor(0.35)).toBe(1);
  });
});
```

Export the `towardness` computation as `towardnessFor(face: number): number` so it can be tested
without a canvas.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `towardnessFor(0.7)` is 0 today (the fade only starts at 0.55).

- [ ] **Step 3: Implement**

```ts
/**
 * How much of the chest-on view to blend in. The window starts EARLIER than the original 0.55: the
 * band between full profile and 0.55 is where a squashed flat billboard still reads as paper, and
 * widening the ramp is the cheapest way to shrink that band. Ends above the `m` floor so the profile
 * underneath is fully hidden before it becomes degenerate.
 */
export function towardnessFor(face: number): number {
  return Math.min(1, Math.max(0, (0.75 - Math.abs(face)) / 0.4));
}
```

Also raise the `m` clamp from `0.03` to a real minimum ribcage width (~`0.16`). `0.03` exists only to
avoid a degenerate matrix — it should never have been the *visual* floor. In life a dog seen end-on
is still as wide as its ribcage.

- [ ] **Step 4: Run tests, verify on a turn, commit**

```bash
pnpm vitest run packages/web/src/live/office-scene/
git commit -am "Widen the dog's chest-on crossfade and floor the body depth at a ribcage."
```

---

# Part 2 · Sound

## Task 4: Stand up the sound test harness

**Files:**
- Create: `packages/web/src/live/sound.test.ts`
- Modify: `packages/web/src/live/sound.ts` (export the roll table)

`sound.ts` has no tests today. Everything below needs somewhere to land, and the parts worth testing
are **logic, not audio** — which event fires, under what gate, with what pan. Levels are verified by
offline render, not by unit test.

**Interfaces:**
- Produces: `LIFE_EVENTS: readonly { name: string; weight: number }[]` — the roll table, extracted
  from the inline `if (roll < 0.34) … else if …` chain in `life()`.
- Produces: `pickLifeEvent(roll: number, ctx: LifeContext): string` — pure, testable selection.
- Produces: `interface LifeContext { pairs: { x: number }[]; dog: { x: number } | null }`.

- [ ] **Step 1: Write the failing test**

```ts
describe('the life event roll', () => {
  it('weights sum to one', () => {
    const total = LIFE_EVENTS.reduce((s, e) => s + e.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('is deterministic for a given roll', () => {
    const ctx = { pairs: [], dog: null };
    expect(pickLifeEvent(0.5, ctx)).toBe(pickLifeEvent(0.5, ctx));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/sound.test.ts
```

- [ ] **Step 3: Extract the roll**

Replace the inline chain in `life()` with `LIFE_EVENTS` + `pickLifeEvent`, then dispatch on the
returned name. Behaviour must be unchanged at this step — this is a pure refactor so the following
tasks have a seam.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "Extract the life-event roll into a testable table."
```

## Task 5: Rebuild the typing

**Files:**
- Modify: `packages/web/src/live/sound.ts` (`keys`, `click`)
- Test: `packages/web/src/live/sound.test.ts`

Today `keys()` plays a run of single bandpass bursts at 1650–2550 Hz, Q 2.2. Two complaints, one
root: it is **one transient** (so it sounds fake) and it peaks at **−25 against a −33.7 bed** — about
9 dB over the room, the loudest thing in the layer.

- [ ] **Step 1: Write the failing test**

```ts
describe('typing', () => {
  it('plays two transients per key — a real press is a thock down and a click up', () => {
    const sched = captureSchedule(() => engine.keys(fakeCtx, fakeOut));
    // Two transients per key means at least twice as many scheduled sources as keys.
    expect(sched.sources.length).toBeGreaterThanOrEqual(sched.keyCount * 2);
  });

  it('keeps one keyboard per run and a different one next run', () => {
    const a = keyboardFor(1);
    const b = keyboardFor(2);
    expect(keyboardFor(1)).toEqual(a);
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

```ts
/**
 * One keypress: a low thock as the key bottoms out and a lighter click as it releases. The original
 * played only the bright half, which is why it read as fake AND as the loudest thing in the room —
 * both complaints had the same root (nick, 2026-07-30).
 *
 * `kb` is drawn ONCE PER RUN, not per key: every keystroke in the office used to be the same
 * keyboard, so a burst at one desk sounded identical to a burst at another.
 */
private keypress(ctx: AudioContext, out: AudioNode, at: number, kb: Keyboard): void {
  this.click(ctx, out, at, kb.body, kb.downGain, 0.05);           // key-down thock
  this.click(ctx, out, at + kb.gap, kb.body * 2.6, kb.upGain, 0.03); // release click
}
```

Drop the down-stroke body roughly an octave from today's 1650–2550 Hz range, and cut the gains so
typing sits **at or just above** the bed rather than 9 dB over it. Keep the existing run structure —
the uneven rate and the long-run thinking pause both work and are not the problem.

- [ ] **Step 4: Re-measure offline**

Render through the same offline graph the file's comment block documents and record the new
keystroke peak alongside the existing table. **Target: at or just above the bed.** Do not tune finer
than ±3 dB — the readings do not carry it.

- [ ] **Step 5: Update the source comment**

The measured-peaks comment is the only record of how this layer is calibrated. A change that leaves
it stale is worse than no change.

- [ ] **Step 6: Run tests, listen, commit**

```bash
git commit -am "Rebuild typing as two transients per key, quieter, one keyboard per run."
```

## Task 6: Proximity-gated chatter

**Files:**
- Modify: `packages/web/src/live/sound.ts` (`murmur`, `pickLifeEvent`, new `setOccupancy`)
- Modify: `packages/web/src/live/office-scene/index.ts` (push the summary)
- Test: `packages/web/src/live/sound.test.ts`

Today `murmur()` fires from the roll regardless of who is present — an empty office murmurs to
itself.

**Interfaces:**
- Produces: `roomTone.setOccupancy(ctx: LifeContext): void` — one-way. The scene pushes; **the sound
  engine never reads the scene.** That is what keeps `sound.ts` testable without a canvas.

- [ ] **Step 1: Write the failing test**

```ts
describe('chatter', () => {
  const near = { pairs: [{ x: 0.3 }], dog: null };
  const alone = { pairs: [], dog: null };

  it('never fires with nobody near anybody', () => {
    for (let r = 0; r < 1; r += 0.01) expect(pickLifeEvent(r, alone)).not.toBe('murmur');
  });

  it('fires when two members actually share a zone', () => {
    const hits = [];
    for (let r = 0; r < 1; r += 0.01) hits.push(pickLifeEvent(r, near));
    expect(hits).toContain('murmur');
  });

  it('pans toward the pair, not at random', () => {
    expect(panFor('murmur', near)).toBeCloseTo(0.3 * 0.75, 5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Gate `murmur` in `pickLifeEvent` on `ctx.pairs.length > 0`, redistributing its weight to the other
events when it is unavailable (so an empty office is not simply quieter by one slot — it should still
have its own life). Pan toward `pairs[i].x` rather than the random pan every other event uses.

In `index.ts`, compute pairs from the scene: two members **sharing a pod, both in the huddle, or both
in the lounge**. Not a headcount — a headcount of two at opposite ends of the floor is not a
conversation. Push it with `roomTone.setOccupancy(…)` on the same cadence the scene already
reconciles.

Add a **whisper** variant: the same synth at lower level with a tighter formant band. Nick asked for
"chat or whisper", and the two are one synth apart.

- [ ] **Step 4: Run tests, listen with two members present, commit**

```bash
git commit -am "Gate chatter on real proximity and pan it toward the pair."
```

## Task 7: The new event vocabulary

**Files:**
- Modify: `packages/web/src/live/sound.ts`
- Test: `packages/web/src/live/sound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('has every requested event in the roll', () => {
  const names = LIFE_EVENTS.map((e) => e.name);
  for (const n of ['stapler', 'drawer', 'footsteps', 'sip', 'blow', 'water', 'eating']) {
    expect(names).toContain(n);
  }
});

it('keeps work and talk the majority of the mix', () => {
  const chatter = LIFE_EVENTS.filter((e) => ['keys', 'murmur'].includes(e.name));
  const weight = chatter.reduce((s, e) => s + e.weight, 0);
  expect(weight).toBeGreaterThan(0.5);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement each event**

All band-limited noise through the shared `click` / burst shapes unless noted:

| Event | Shape |
| --- | --- |
| `stapler` | two-stage: a short press, then the sharp *ka-chunk* of the staple setting |
| `drawer` | a wooden slide (filtered noise swell over ~0.4 s) into a hard stop |
| `footsteps` | paced pairs of soft low thuds, **panning as they cross** — the drift is the whole effect |
| `sip` | a short liquid intake, higher and lighter than a swallow |
| `blow` | a breath swell — wideband noise through a slow-opening lowpass, **no transient** |
| `water` | a lower, wetter swallow than `sip` |
| `eating` | soft irregular crunches at an uneven rate |

Rebalance the weights so the additions do not swamp typing and talk — these are seasoning.

**Out of scope:** tying these to the desk props that already exist (`deskCoffee`, `deskWater`).
Positional prop-tied audio is a bigger idea than a sound vocabulary and belongs in its own pass.

- [ ] **Step 4: Run tests, listen for ten minutes, commit**

Ten minutes is the actual acceptance test — if any event has become predictable, add jitter to it.

```bash
git commit -am "Add seven small office noises to the life layer."
```

## Task 8: Dog sounds

**Files:**
- Modify: `packages/web/src/live/sound.ts`
- Modify: `packages/web/src/live/office-scene/index.ts` (dog position into `LifeContext`)
- Test: `packages/web/src/live/sound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('dog sounds', () => {
  it('never fires with no dog present', () => {
    const noDog = { pairs: [], dog: null };
    for (let r = 0; r < 1; r += 0.01) {
      expect(['paws', 'jingle', 'yawn', 'bark']).not.toContain(pickLifeEvent(r, noDog));
    }
  });

  it('keeps the bark rare — a bark on a timer is an alarm clock', () => {
    const bark = LIFE_EVENTS.find((e) => e.name === 'bark')!;
    expect(bark.weight).toBeLessThan(0.02);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

- `paws` — very soft padding, on the gait phase, only while the dog is walking.
- `jingle` — a short cluster of tiny bright transients (the dog already wears a mustard collar).
- `yawn` — a breath swell with a small pitch contour.
- `bark` — a single quiet one, **rare**. Rarity is the entire design.

All panned to the dog's position from `ctx.dog.x`.

- [ ] **Step 4: Run tests, listen, commit**

```bash
git commit -am "Give the dog paws, a collar, a yawn and a rare quiet bark."
```

## Task 9: Full-suite gate

- [ ] **Step 1: Run everything**

```bash
pnpm vitest run
pnpm --filter @musterd/web build
pnpm perf:check
pnpm lint
pnpm exec prettier --check "packages/web/src/live/**/*.ts"
```

**Never run `pnpm format`** — use `pnpm exec prettier --write <your files>`.

- [ ] **Step 2: Confirm the calibration comment is current**

Every level touched in Tasks 5–8 must appear in the measured-peaks table in `sound.ts`. That comment
is the layer's only calibration record.

- [ ] **Step 3: Listen once, end to end**

Enable both toggles on `/live` with two members present and the dog walking. Typing should sit *in*
the room. Conversation should come from the side the pair is on. Nothing should be predictable.

- [ ] **Step 4: Commit and PR**

```bash
git commit -am "Gate the life pass: full suite, perf, lint."
gh pr create --fill
gh pr merge --squash --auto --delete-branch
```

---

## Self-review

**Spec coverage:** Part 1 diagnosis → Task 1; torso volume → Task 2; crossfade + body depth floor →
Task 3. Part 2 ground rules → Global Constraints; typing → Task 5; chatter → Task 6; new events →
Task 7; dog sounds → Task 8; testing → Tasks 4 and 9. **No gaps.**

**Type consistency:** `LifeContext { pairs: {x}[]; dog: {x} | null }` is defined in Task 4 and
consumed unchanged in 6, 7 and 8. `pickLifeEvent(roll, ctx)` keeps its signature throughout.
`LIFE_EVENTS` entries are `{ name, weight }` in every task that touches them.

**Ordering note:** Task 4 is a pure refactor and must land before 5–8 — they all need the
`pickLifeEvent` seam. Tasks 2 and 3 (the dog) are independent of the whole sound half and can be done
in either order relative to it.

**Known soft spot:** `captureSchedule` / `fakeCtx` / `fakeOut` / `panFor` / `keyboardFor` do not
exist. Build them in Task 4 as a small WebAudio stub that records scheduled sources rather than
producing sound — `sound.ts` never needs a real AudioContext to be tested for *which* event fires.
