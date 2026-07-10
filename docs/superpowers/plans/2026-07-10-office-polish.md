# Office polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live isometric office stable personal desk details, meaningful mustard Act relationships, and more legible Revive choreography without changing the protocol.

**Architecture:** Keep scene rendering in `office-scene/render.ts`, deterministic desk-mood assignment in a small pure module, and choreography orchestration in `office-scene/index.ts`. Golden-thread effects remain transient local cues; they do not become protocol fields. Revive remains optional, with the existing code-drawn avatar fallback.

**Tech Stack:** TypeScript, Canvas 2D, CSS overlays, Vitest, `@rive-app/canvas-advanced`.

---

### Task 1: Add deterministic desk moods

**Files:**
- Create: `packages/web/src/live/office-scene/moods.ts`
- Create: `packages/web/src/live/office-scene/moods.test.ts`

- [ ] **Step 1: Write the failing tests**

Test that `deskMoodFor(teamName, memberName)`:

```ts
expect(deskMoodFor('revive', 'miley')).toBe(deskMoodFor('revive', 'miley'));
expect(deskMoodFor('revive', 'miley')).not.toBe(deskMoodFor('other-team', 'miley'));
expect(DESK_MOODS).toContain(deskMoodFor('revive', 'miley'));
```

Also test that changing unrelated member order does not change a mood and that every mood exposes a
bounded prop configuration rather than an unbounded random value.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @musterd/web exec vitest run packages/web/src/live/office-scene/moods.test.ts
```

Expected: FAIL because `moods.ts` does not exist.

- [ ] **Step 3: Implement the pure mood module**

Define a fixed `DeskMood` union, a `DESK_MOODS` tuple, a stable string hash, and a `deskMoodFor` function.
Define a `DeskMoodStyle` record containing only the existing scene-level choices: prop enablement,
accent color, and a small ambient preference. Do not add role or personality fields to `OfficeNode`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same Vitest command. Expected: PASS.

### Task 2: Apply desk moods to the office scene

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/index.ts`
- Modify: `packages/web/src/live/office-scene/render.test.ts`

- [ ] **Step 1: Extend render tests**

Add tests proving that the same member name gets the same mood-derived desk treatment after repeated
scene renders, while a different Team seed can produce a different treatment. Keep the assertions on
pure exported helpers rather than pixel snapshots.

- [ ] **Step 2: Run the focused render tests and verify the new assertions fail**

Run:

```bash
pnpm --filter @musterd/web exec vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: FAIL until render helpers accept the mood.

- [ ] **Step 3: Thread the mood seed into rendering**

Pass the Team name from the live data into the office scene without changing the protocol envelope. Use
the existing Member name as the stable identity input. Let mood styles select from the existing props and
palette instead of adding new dependencies or new canvas primitives for every mood.

- [ ] **Step 4: Re-run render tests**

Run the focused render test command. Expected: PASS.

- [ ] **Step 5: Check the visual result**

Run the web development surface, confirm desks remain readable at desktop and narrow widths, and verify
that prop details remain subordinate to characters, labels, and monitors.

### Task 3: Add golden-thread transient cues

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/index.ts`
- Modify: `packages/web/src/live/office-scene/types.ts`
- Create or modify: `packages/web/src/live/office-scene/render.test.ts`

- [ ] **Step 1: Write cue behavior tests**

Test the pure cue geometry/helper for a short-lived mustard relationship between two known anchors, with
no cue generated when either anchor is absent. Test that reduced-motion mode does not schedule the
animated cue.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @musterd/web exec vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: FAIL because the relationship cue does not exist.

- [ ] **Step 3: Implement the local cue**

Add a local `thread` cue kind with a start and end point, mustard color, bounded lifetime, and a
low-contrast draw path. Map only existing office event kinds such as handoff, help, accept, resolve, and
megaphone to the cue. Keep the protocol union unchanged; any added union is internal to
`OfficeEvent`/`Cue` rendering only.

- [ ] **Step 4: Add reduced-motion and rate limiting**

Gate thread scheduling on `reduced`, and coalesce repeated thread cues from the same sender during the
existing cue lifetime. Preserve the readable speech bubble and stream event when the visual cue is
suppressed.

- [ ] **Step 5: Run focused tests**

Run the render and office-scene test files. Expected: PASS.

### Task 4: Verify and polish Revive choreography

**Files:**
- Modify: `packages/web/src/live/office-scene/actors.ts`
- Modify: `packages/web/src/live/office-scene/rive-rig.ts`
- Modify: `packages/web/src/live/office-scene/rig.ts`
- Modify: `packages/web/src/live/office-scene/actors.test.ts`
- Modify: `packages/web/src/live/office-scene/rig.test.ts`

- [ ] **Step 1: Add choreography tests**

Cover anticipation before a walk, carry state during handoff, gesture clearing when a real Act starts,
and final return to idle after the movement completes. Assert state transitions and pose values rather
than timing-sensitive rendered pixels.

- [ ] **Step 2: Run the focused actor and rig tests**

Run:

```bash
pnpm --filter @musterd/web exec vitest run packages/web/src/live/office-scene/actors.test.ts packages/web/src/live/office-scene/rig.test.ts
```

Expected: FAIL for any newly specified transition not yet implemented.

- [ ] **Step 3: Implement bounded staging**

Add a short anticipation phase to the existing actor walk state, preserve the handoff carry until arrival,
and keep the existing `SETTLE_FRAMES` Revive afterglow. Ensure the state machine is still advanced only
while a member is moving, gesturing, or settling. Do not reintroduce a continuous idle RAF loop.

- [ ] **Step 4: Improve rig observability**

Expose a development-only load result or diagnostic callback for the existing `loadRiveRig` path so the
web Surface can distinguish loaded-rig rendering from the code-drawn fallback without logging secrets or
spamming production output. Keep the fallback behavior unchanged.

- [ ] **Step 5: Re-run focused tests**

Run the actor and rig test command. Expected: PASS.

### Task 5: Responsive and accessibility pass

**Files:**
- Modify: `packages/web/src/live/Live.css`
- Modify: `packages/web/src/live/office-scene/index.ts`

- [ ] **Step 1: Test the reduced-motion path**

Run the web tests with the existing reduced-motion coverage and manually verify that no thread travel,
ambient choreography, or decorative animation runs when `prefers-reduced-motion: reduce` is active.

- [ ] **Step 2: Tune overlay layering**

Keep golden-thread lines below labels and speech bubbles, above the baked floor, and clipped to the office
canvas. Preserve visible keyboard focus and avoid pointer interception by decorative overlays.

- [ ] **Step 3: Check responsive states**

Verify the office companion view, collapsed rails, desktop split view, and narrow view. Confirm that mood
props do not create horizontal overflow or collide with the roster and stream panels.

### Task 6: Full verification

**Files:**
- No additional files.

- [ ] **Step 1: Run the office-scene suite**

```bash
pnpm --filter @musterd/web exec vitest run packages/web/src/live/office-scene
```

Expected: PASS.

- [ ] **Step 2: Run repository fast gates**

```bash
pnpm typecheck
pnpm format:check
```

Expected: PASS.

- [ ] **Step 3: Run the web package build and lint**

```bash
pnpm --filter @musterd/web build
pnpm --filter @musterd/web lint
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Confirm no protocol schema changed, no runtime dependency was added, and the design specification and
implementation remain aligned.
