# Office Reception Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. On this machine
> subagent-driven execution is disabled — musterd is the coordination layer. Implement inline in your
> own seat, or hand a task to another seat with `team_send {act:'handoff'}`.

**Goal:** Put a front desk at the entrance with a receptionist who is visibly staff rather than
roster, and give arriving members a short check-in beat — never a gate.

**Architecture:** Geometry in `office-scene/layout.ts`, painters in `render.ts`, behaviour in
`actors.ts`. The receptionist is a fixed non-roster figure with her own sleep/wake state; the
check-in beat is a short pause inserted into an arriving member's walk, gated on the **existing**
`setHomes(…, animate)` path so a page reload never replays it.

**Tech Stack:** TypeScript, Canvas 2D, Vitest.

**Spec:** [2026-07-30 office reception](../specs/2026-07-30-office-reception-design.md)

## Global Constraints

- **The receptionist is staff, not roster.** Never a nameplate. Never leaves the desk. Never in a
  headcount, `N/M`, the roster, the work stack, a walk target, or a leisure spot. Every avatar on
  that floor is attested (ADR 101 model attestation, ADR 109 git attribution); she has nothing to
  attest and must not look like she does.
- **The beat is never a gate.** It never blocks presence, never delays the roster, carries no
  protocol meaning, and nobody can fail to check in.
- **Session-observed arrivals only.** Reuse the existing `!initialized || !animate` gate in
  `setHomes` — do not invent a second arrival concept.
- **Simultaneous arrivals check in *in parallel* at their own marks.** They do not form a line. The
  overflow queue strip (`STRIP_CAP`, the "+N waiting" pill) is a different mechanism for a different
  situation and is not touched.
- **Desk and props are baked still layer.** Only the idle animation and the beat touch the per-frame
  loop, and both suspend with the scene when the panel is collapsed or the tab is hidden.
- **The sleeping state must be genuinely cheap** — an empty office must not burn a frame budget on a
  still character.
- **Naming:** `src/live/ReceptionScene.tsx` is an unrelated flat-SVG approval-queue banner (ADR 098).
  This plan does not touch it. Do not merge the two.
- **Tests run from the repo root only:** `pnpm vitest run <path>`.
- **Visual check:** `vite preview` + CDP, never `vite dev`. Restart preview after every build.
- Commit after every task. Branch: `feat/office-presence-chrome`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `office-scene/layout.ts` | geometry | `FRONT_DESK`, `RECEPTIONIST`, `CHECK_IN_MARKS` |
| `office-scene/render.ts` | painters | `frontDesk`, `receptionist` |
| `office-scene/actors.ts` | behaviour | sleep/wake, the beat |
| `office-scene/nav.ts` | pathing | desk blocks |
| `office-scene/{layout,render,actors,nav}.test.ts` | assertions | one describe per task |

---

## Task 1: Place the desk

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (near `RECEPTION`, ~line 315)
- Test: `packages/web/src/live/office-scene/layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FRONT_DESK: { lx: number; ly: number; long: number; deep: number; high: number; dir: Dir };
  export const RECEPTIONIST: { lx: number; ly: number; dir: Dir };
  export const CHECK_IN_MARKS: ReadonlyArray<{ lx: number; ly: number }>;
  ```

`ENTRANCE` is `{ lx: 47, ly: 815 }`. The `RECEPTION` cluster (rug at 170/800, couch at 330/800, table
at 258/800, plant at 335/690) is the waiting area this desk anchors.

- [ ] **Step 1: Write the failing test**

```ts
describe('FRONT_DESK', () => {
  it('sits near the entrance, facing arrivals', () => {
    expect(Math.hypot(FRONT_DESK.lx - ENTRANCE.lx, FRONT_DESK.ly - ENTRANCE.ly)).toBeLessThan(260);
  });

  it('does not block the door swing or sit on the queue strip', () => {
    for (let i = 0; i < STRIP_CAP; i++) {
      const qx = ENTRANCE.lx + 34 + i * 32;
      const qy = ENTRANCE.ly - 10 - i * 6;
      const inDesk =
        Math.abs(qx - FRONT_DESK.lx) < FRONT_DESK.long / 2 &&
        Math.abs(qy - FRONT_DESK.ly) < FRONT_DESK.deep / 2;
      expect(inDesk).toBe(false);
    }
  });

  it('puts the receptionist behind the counter, and the marks in front of it', () => {
    expect(CHECK_IN_MARKS.length).toBeGreaterThanOrEqual(3);
    for (const m of CHECK_IN_MARKS) {
      // marks and receptionist on opposite sides of the counter line
      expect(Math.sign(m.ly - FRONT_DESK.ly)).not.toBe(Math.sign(RECEPTIONIST.ly - FRONT_DESK.ly));
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/layout.test.ts
```

- [ ] **Step 3: Add the geometry**

Place the counter between the door and the `RECEPTION` seating so the couch cluster reads as *its*
waiting area. Add at least three `CHECK_IN_MARKS`, side by side in front of the counter — **parallel,
not a line**, because simultaneous arrivals must not queue.

- [ ] **Step 4: Run tests, commit**

```bash
git add packages/web/src/live/office-scene/layout.ts packages/web/src/live/office-scene/layout.test.ts
git commit -m "Place the front desk, the receptionist and the check-in marks."
```

---

## Task 2: Block nav through the desk

**Files:**
- Modify: `packages/web/src/live/office-scene/nav.ts`
- Test: `packages/web/src/live/office-scene/nav.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('routes around the front desk, never through it', () => {
  const path = pathBetween({ lx: ENTRANCE.lx, ly: ENTRANCE.ly }, DESK_SLOTS[0]!);
  for (const step of path) {
    const inDesk =
      Math.abs(step.lx - FRONT_DESK.lx) < FRONT_DESK.long / 2 &&
      Math.abs(step.ly - FRONT_DESK.ly) < FRONT_DESK.deep / 2;
    expect(inDesk).toBe(false);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Add `FRONT_DESK` to the blocker set the bookshelves already use — same pattern, same footprint math.

- [ ] **Step 4: Run the whole scene suite**

```bash
pnpm vitest run packages/web/src/live/office-scene/
```

A newly-unreachable desk means the counter is wider than the corridor. Shrink the counter; do not
widen the room.

- [ ] **Step 5: Commit**

```bash
git commit -am "Block nav through the front desk."
```

---

## Task 3: Paint the desk

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts`
- Test: `packages/web/src/live/office-scene/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('draws a counter with a raised transaction ledge', () => {
  const boxes = capturedBoxes(() =>
    renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
  );
  const desk = boxes.filter((b) => b.tag === 'front-desk');
  const ledge = boxes.filter((b) => b.tag === 'front-desk-ledge');
  expect(desk).toHaveLength(1);
  expect(ledge).toHaveLength(1);
  expect(ledge[0]!.up).toBeGreaterThan(desk[0]!.up);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

```ts
/**
 * The front desk. The RAISED LEDGE is the load-bearing detail: a counter without one is just a big
 * desk, and the ledge is what makes the whole corner read as reception rather than as another
 * workstation. Everything else here is dressing.
 */
function frontDesk(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const D = FRONT_DESK;
  box(ctx, fit, D.lx, D.ly, D.long, D.deep, D.high, PAL.wood);            // carcass
  box(ctx, fit, D.lx, D.ly, D.long + 6, D.deep + 4, 5, woodTop(), D.high); // the ledge
  // monitor turned away from the room, phone, small plant, visitor log
  …
}
```

Register it as a depth item so it sorts with the rest of the furniture, and call `drawPlant` for its
plant rather than re-inventing one.

- [ ] **Step 4: Run tests, verify visually, commit**

```bash
git commit -am "Paint the front desk with its transaction ledge and props."
```

---

## Task 4: The receptionist, asleep

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/actors.ts`
- Test: `packages/web/src/live/office-scene/actors.test.ts`

Start with the sleeping state, because it is the one the empty office shows and it is the cheap one.

- [ ] **Step 1: Write the failing test**

```ts
describe('the receptionist', () => {
  it('is asleep when nobody is in', () => {
    const eng = engineWith([]);
    expect(eng.receptionist().state).toBe('asleep');
  });

  it('is never a member', () => {
    const eng = engineWith([node('ada', 'working')]);
    expect(eng.nodes().has('receptionist')).toBe(false);
    expect(eng.walkTargets()).not.toContain('receptionist');
    expect(LEISURE_SPOTS.every((s) => s.lx !== RECEPTIONIST.lx || s.ly !== RECEPTIONIST.ly)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Add a `receptionist` state to the engine — **outside** the member node map, so she cannot leak into a
headcount by accident. States: `asleep | waking | idle | greeting`.

Painter: seated behind the counter, so most of the body is occluded — the read is head, shoulders and
arms, which is what keeps her cheap. Distinct palette and silhouette from member avatars.

Asleep: slumped, slow breathing. **The still pose must not schedule per-frame work beyond the
breathing curve** — an empty office is the common case.

- [ ] **Step 4: Run tests, verify the empty office visually, commit**

The empty office is the state this task changes most — look at it.

```bash
git commit -am "Add the receptionist, dozing behind the front desk."
```

---

## Task 5: Wake, idle, and go back to sleep

**Files:**
- Modify: `packages/web/src/live/office-scene/actors.ts`
- Test: `packages/web/src/live/office-scene/actors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('wakes on the first arrival and stays awake while anyone is present', () => {
  const eng = engineWith([]);
  eng.setHomes(placements([node('ada', 'working')]), byName, true);
  expect(eng.receptionist().state).not.toBe('asleep');
});

it('goes back to sleep a beat after the last member leaves, not instantly', () => {
  const eng = engineWith([node('ada', 'working')]);
  eng.setHomes(placements([]), new Map(), true);
  expect(eng.receptionist().state).not.toBe('asleep'); // still awake right after
  eng.advance(RECEPTIONIST_SLEEP_DELAY + 1);
  expect(eng.receptionist().state).toBe('asleep');
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Wake on first arrival; stay awake while anyone is present; return to sleep after
`RECEPTIONIST_SLEEP_DELAY`. **Not instantly** — an instant snap back to slumped reads as a bug rather
than as the joke it is.

Awake idles — types, sips, shuffles paper — sparse, on the same cadence discipline as the existing
desk micro-beats. Reuse that machinery; do not add a second idle scheduler.

- [ ] **Step 4: Run tests, commit**

```bash
git commit -am "Wake the receptionist on arrival; let her doze off again after the last member."
```

---

## Task 6: The check-in beat

**Files:**
- Modify: `packages/web/src/live/office-scene/actors.ts`
- Test: `packages/web/src/live/office-scene/actors.test.ts`

**This is the task with the trap in it.** Read the whole task before starting.

- [ ] **Step 1: Write the failing test — the reload case first**

```ts
describe('the check-in beat', () => {
  it('does NOT fire for members already present on the first snapshot', () => {
    const eng = engineWith([]);
    // The first reconcile is how a page load seats the room. Everyone in it is "new" to the client
    // but none of them just arrived — without this gate a refresh replays the whole ritual and you
    // get seven people queueing at the door because somebody hit reload.
    eng.setHomes(placements([node('ada'), node('bo'), node('cy')]), byName, false);
    expect(eng.pendingCheckIns()).toHaveLength(0);
  });

  it('fires exactly once for a member who appears in a later update', () => {
    const eng = engineWith([]);
    eng.setHomes(placements([node('ada')]), byName, false);
    eng.setHomes(placements([node('ada'), node('bo')]), byName, true);
    expect(eng.pendingCheckIns()).toEqual(['bo']);
  });

  it('checks simultaneous arrivals in at their own marks, in parallel', () => {
    const eng = engineWith([]);
    eng.setHomes(placements([node('ada')]), byName, false);
    eng.setHomes(placements([node('ada'), node('bo'), node('cy')]), byName, true);
    const marks = eng.pendingCheckIns().map((n) => eng.checkInMark(n));
    expect(new Set(marks).size).toBe(2); // distinct marks, not a queue
  });

  it('never strands an arrival at the mark', () => {
    const eng = engineWith([]);
    eng.setHomes(placements([node('ada')]), byName, false);
    eng.setHomes(placements([node('ada'), node('bo')]), byName, true);
    eng.advance(CHECK_IN_MS * 3);
    expect(eng.pendingCheckIns()).toHaveLength(0);
    expect(eng.nodeAt('bo')).toEqual(deskHomeOf('bo'));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/actors.test.ts
```

- [ ] **Step 3: Implement, hanging off the existing gate**

`setHomes` already gates on:

```ts
if (!initialized || !animate) { /* seat everyone, no animation */ }
```

That is the same gate the door fade and the dog's greeting (`takeArrivals`) use. **Add the beat to
that path — do not add a second arrival concept.** Concretely: only members that arrive on an
`animate` reconcile of an already-`initialized` engine get a mark.

The beat itself, ~1.2 s (`CHECK_IN_MS`):

1. Arriving member walks to a free mark rather than straight to their desk.
2. Pause; receptionist enters `greeting`, looks up.
3. Badge glyph flashes.
4. Member continues to their desk.

Assign marks round-robin over free ones. If arrivals exceed `CHECK_IN_MARKS.length`, the extras
**skip the beat and walk straight in** — the beat is ceremony, and ceremony that causes a queue is
the gate we explicitly rejected.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/web/src/live/office-scene/
```

- [ ] **Step 5: Verify the reload case by hand**

This is the one that will regress later. Open `/live` with several members present and **hit reload
five times.** Nobody should ever pause at the desk. Then have a member actually join and watch the
beat play once.

- [ ] **Step 6: Commit**

```bash
git commit -am "Add the check-in beat, gated on session-observed arrivals only."
```

---

## Task 7: Full-suite gate

- [ ] **Step 1: Run everything**

```bash
pnpm vitest run
pnpm --filter @musterd/web build
pnpm perf:check
pnpm lint
pnpm exec prettier --check "packages/web/src/live/**/*.ts"
```

**Never run `pnpm format`** — use `pnpm exec prettier --write <your files>`.

- [ ] **Step 2: Confirm she is still not a member**

Check by eye on `/live`: no nameplate over the receptionist, no change to the headcount or `N/M`, she
does not appear in the ROSTER tab or the work stack, and she never walks.

- [ ] **Step 3: Check the empty office and the collapsed panel**

Empty office: someone dozing, not a dead still. Collapsed panel and hidden tab: the loop suspends —
this is the standing rule and a new animated figure is exactly the kind of thing that breaks it.

- [ ] **Step 4: Commit and PR**

```bash
git commit -am "Gate the reception pass: full suite, perf, lint."
gh pr create --fill
gh pr merge --squash --auto --delete-branch
```

---

## Self-review

**Spec coverage:** layout (`FRONT_DESK`, `CHECK_IN_MARKS`, `RECEPTIONIST`, nav blocking) → Tasks 1–2.
Painters (`frontDesk`, the receptionist figure) → Tasks 3–4. Behaviour: asleep when empty → Task 4;
wake/idle/re-sleep → Task 5; the beat and the reload trap → Task 6. Testing and perf → Task 7.
Out-of-scope items (no real gating, no name/voice, no approval-queue wiring, sound deferred to spec
B) are carried in the Global Constraints. **No gaps.**

**Type consistency:** `FRONT_DESK` / `RECEPTIONIST` / `CHECK_IN_MARKS` are defined once in Task 1 and
consumed unchanged in 2, 3, 4 and 6. `receptionist().state` is `'asleep' | 'waking' | 'idle' |
'greeting'` in Tasks 4, 5 and 6. `CHECK_IN_MS` and `RECEPTIONIST_SLEEP_DELAY` are each defined once.

**Ordering note:** Tasks 1 → 2 → 3 are strictly sequential (geometry, then nav, then paint). Task 4
depends on 1 and 3. Tasks 5 and 6 both depend on 4 and are independent of each other.

**Known soft spots:** the test helpers `engineWith`, `placements`, `byName`, `eng.advance`,
`eng.nodes`, `eng.walkTargets`, `eng.nodeAt`, `deskHomeOf`, `pathBetween`, `capturedBoxes`,
`recordingCtx` and the `tag`/`up` fields on captured boxes do not all exist yet. `actors.test.ts`
already builds most of this shape — extend it rather than starting a parallel harness. The
`capturedBoxes` helpers are shared with the room-dressing plan; whichever lands first builds them.
