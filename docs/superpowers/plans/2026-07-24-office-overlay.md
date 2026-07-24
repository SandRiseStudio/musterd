# Office Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/broadcast`'s placeholder LIVE pill with one shared `OfficeOverlay` — identity, live
signal, and a working-on lane strap — rendered identically on `/live` and `/broadcast`.

**Architecture:** All display decisions live in a pure module (`workingOn.ts`) that is unit-tested; a
thin hook (`useWorkingOn`) does the fetch and firehose-driven invalidation; `OfficeOverlay` is thin
JSX over both, rendered inside `OfficeScene` so both routes get it by construction. Spec:
[docs/superpowers/specs/2026-07-24-broadcast-overlay-design.md](../specs/2026-07-24-broadcast-overlay-design.md).

**Tech Stack:** React 19 + TanStack Router, TypeScript, vitest (node environment), plain CSS with
design tokens. No new dependencies.

## Global Constraints

- **No new dependencies.** Anything imported must already be in the tree (`packages/web/AGENTS.md`).
- **Fonts: Fraunces, Space Grotesk, Space Mono only.** No new family or weight.
- **`pnpm perf:check` must pass** against `docs/perf/budgets.json`. Raising a budget requires logging
  the measured cost in `docs/perf/web-live-baseline.md` in the same PR (ADR 151).
- **No new render loop.** No `requestAnimationFrame`, `setInterval`, or `setTimeout`-driven animation.
  All motion is CSS, event-triggered, and finite.
- **No polling.** Lane data refreshes only on `lane_*` envelopes already arriving on the firehose.
- **Tests are `.test.ts`, environment `node`** (`vitest.config.ts` includes `packages/**/*.test.ts`).
  There is no jsdom or testing-library in this repo — do not add one; test pure functions instead.
- **Presence safety (ADR 155):** `/broadcast` keeps `acquireObserver` and gains no advanced-seat path.
- **Disclosure:** `/broadcast` stays on the **full-grade** observer deliberately (nick, 2026-07-24).
  Do not "fix" it to public-grade.
- **Look and feel:** warm office palette (`--mustard-500`, `--glow-mustard-soft`), frosted-glass
  materials, Space Grotesk display + Space Mono tags, quiet at rest, one-shot motion on change.
- Run `pnpm exec prettier --write <files>` — **never** `pnpm format`.
- Vitest runs **from the repo root only**.

---

## File Structure

| File                                               | Responsibility                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/web/src/live/workingOn.ts` (create)      | Pure derivation: which lanes to show, in what order, capped; present-member count; whether an envelope invalidates the board. |
| `packages/web/src/live/workingOn.test.ts` (create) | Unit tests for the above — including the no-refetch-on-non-lane-acts perf claim.                                              |
| `packages/web/src/live/useWorkingOn.ts` (create)   | Thin hook: one fetch on connect, re-fetch on lane envelopes. Deliberately logic-free.                                         |
| `packages/web/src/live/OfficeOverlay.tsx` (create) | Presentational component. Props in, JSX out; no effects, no timers.                                                           |
| `packages/web/src/live/Live.css` (modify)          | Overlay styles. Already loaded by **both** routes, so it is the shared stylesheet.                                            |
| `packages/web/src/live/OfficeScene.tsx` (modify)   | Renders `<OfficeOverlay>` as an HTML sibling of the canvas.                                                                   |
| `packages/web/src/routes/broadcast.tsx` (modify)   | Delete `BroadcastOverlay`; pass lanes into the scene.                                                                         |
| `packages/web/src/routes/live.tsx` (modify)        | Pass lanes into the scene; drop the now-duplicate topbar team name + status pill.                                             |
| `packages/web/src/live/Broadcast.css` (modify)     | Delete placeholder overlay styles; keep stage/letterbox only.                                                                 |

---

### Task 1: Pure derivation module

**Files:**

- Create: `packages/web/src/live/workingOn.ts`
- Test: `packages/web/src/live/workingOn.test.ts`

**Interfaces:**

- Consumes: `Lane`, `LaneBoard`, `MemberSummary`, `Envelope` from `@musterd/protocol`; `laneEvent`
  from `./format`.
- Produces:
  - `interface WorkingOnEntry { id: string; title: string; owner: string; state: LaneState }`
  - `function workingOn(board: LaneBoard | null, limit: number): WorkingOnEntry[]`
  - `function presentCount(roster: MemberSummary[]): number`
  - `function invalidatesLanes(env: Pick<Envelope, 'act' | 'meta'>): boolean`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/live/workingOn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard, MemberSummary } from '@musterd/protocol';
import { invalidatesLanes, presentCount, workingOn } from './workingOn';

function lane(over: Partial<Lane>): Lane {
  return {
    id: 'L1',
    team: 'revive',
    project: 'default',
    title: 'a lane',
    detail: null,
    owner_seat: 'miley',
    role: null,
    surface_globs: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    state: 'claimed',
    created_by: 'miley',
    created_at: 1,
    claimed_at: 1,
    resolved_at: null,
    updated_at: 1,
    ...over,
  } as Lane;
}
const board = (lanes: Lane[]): LaneBoard => ({ lanes, warnings: [] });

describe('workingOn', () => {
  it('returns nothing when the board has not loaded', () => {
    expect(workingOn(null, 3)).toEqual([]);
  });

  it('keeps only owned, in-flight lanes', () => {
    const result = workingOn(
      board([
        lane({ id: 'A', state: 'claimed' }),
        lane({ id: 'B', state: 'active' }),
        lane({ id: 'C', state: 'blocked' }),
        lane({ id: 'D', state: 'done' }),
        lane({ id: 'E', state: 'abandoned' }),
        lane({ id: 'F', state: 'claimed', owner_seat: null }),
      ]),
      10,
    );
    expect(result.map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('orders most recently claimed first', () => {
    const result = workingOn(
      board([
        lane({ id: 'old', claimed_at: 100 }),
        lane({ id: 'new', claimed_at: 300 }),
        lane({ id: 'mid', claimed_at: 200 }),
      ]),
      10,
    );
    expect(result.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to updated_at when a lane has never been claimed', () => {
    const result = workingOn(
      board([
        lane({ id: 'claimed', claimed_at: 100, updated_at: 100 }),
        lane({ id: 'unclaimed-but-active', claimed_at: null, updated_at: 500 }),
      ]),
      10,
    );
    expect(result[0].id).toBe('unclaimed-but-active');
  });

  it('caps at the limit', () => {
    const lanes = [1, 2, 3, 4, 5].map((n) => lane({ id: `L${n}`, claimed_at: n }));
    expect(workingOn(board(lanes), 2).map((r) => r.id)).toEqual(['L5', 'L4']);
  });

  it('projects only what the overlay renders', () => {
    expect(
      workingOn(board([lane({ id: 'A', title: 'ship it', owner_seat: 'stanley' })]), 1),
    ).toEqual([{ id: 'A', title: 'ship it', owner: 'stanley', state: 'claimed' }]);
  });
});

describe('presentCount', () => {
  const member = (name: string, presence: MemberSummary['presence']): MemberSummary =>
    ({ name, kind: 'agent', presence }) as MemberSummary;

  it('counts everyone not offline', () => {
    expect(
      presentCount([member('a', 'online'), member('b', 'offline'), member('c', 'online')]),
    ).toBe(2);
  });

  it('is zero for an empty roster', () => {
    expect(presentCount([])).toBe(0);
  });
});

describe('invalidatesLanes', () => {
  it('is true for lane events', () => {
    expect(invalidatesLanes({ act: 'message', meta: { lane_claim: { lane: 'L1' } } })).toBe(true);
    expect(invalidatesLanes({ act: 'message', meta: { lane_open: { lane: 'L1' } } })).toBe(true);
    expect(invalidatesLanes({ act: 'message', meta: { lane_resolve: { lane: 'L1' } } })).toBe(true);
  });

  // The perf claim, asserted rather than assumed: ordinary chatter must never trigger a fetch.
  it('is false for ordinary acts', () => {
    expect(invalidatesLanes({ act: 'status_update', meta: null })).toBe(false);
    expect(invalidatesLanes({ act: 'ask', meta: { species: 'consult' } })).toBe(false);
    expect(invalidatesLanes({ act: 'handoff', meta: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from the repo root: `pnpm vitest run packages/web/src/live/workingOn.test.ts`
Expected: FAIL — `Failed to resolve import "./workingOn"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/live/workingOn.ts`:

```ts
import type { Envelope, Lane, LaneBoard, LaneState, MemberSummary } from '@musterd/protocol';
import { laneEvent } from './format';

/**
 * The overlay's pure derivation. Every decision the working-on strap makes lives here, so the
 * component stays thin JSX and the behaviour is testable in a node environment (this repo has no
 * jsdom — see vitest.config.ts).
 */

/** A lane as the strap renders it — deliberately narrower than `Lane`, so the view cannot drift. */
export interface WorkingOnEntry {
  id: string;
  title: string;
  owner: string;
  state: LaneState;
}

/** In-flight = someone is on it right now. `done`/`abandoned` are history, not work. */
const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked'];

/** Most-recent activity first: when a lane was claimed, else when it last moved. */
function recency(lane: Lane): number {
  return lane.claimed_at ?? lane.updated_at;
}

/**
 * The lanes worth putting on screen: owned, in flight, freshest first, capped at `limit`.
 * A null board (not yet fetched) yields nothing rather than a flash of empty chrome.
 */
export function workingOn(board: LaneBoard | null, limit: number): WorkingOnEntry[] {
  if (!board) return [];
  return board.lanes
    .filter((l) => l.owner_seat !== null && IN_FLIGHT.includes(l.state))
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, limit)
    .map((l) => ({ id: l.id, title: l.title, owner: l.owner_seat as string, state: l.state }));
}

/** How many teammates are in the room. Offline is the only absence (ADR 010 hides grace). */
export function presentCount(roster: MemberSummary[]): number {
  return roster.filter((m) => m.presence !== 'offline').length;
}

/**
 * Does this envelope mean the lane board changed? Lane acts are self-announcing on the firehose both
 * routes already subscribe to, so this is the whole refresh trigger — there is no polling, and
 * ordinary chatter costs a viewer nothing.
 */
export function invalidatesLanes(env: Pick<Envelope, 'act' | 'meta'>): boolean {
  return laneEvent(env) !== null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/web/src/live/workingOn.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/workingOn.ts packages/web/src/live/workingOn.test.ts
git add packages/web/src/live/workingOn.ts packages/web/src/live/workingOn.test.ts
git commit -m "feat(web): working-on derivation for the office overlay"
```

---

### Task 2: The data hook

**Files:**

- Create: `packages/web/src/live/useWorkingOn.ts`

**Interfaces:**

- Consumes: `invalidatesLanes` (Task 1); `fetchLaneBoard`, `type LiveConfig` from `./client`.
- Produces: `function useWorkingOn(cfg: LiveConfig | null, envelopes: Envelope[]): LaneBoard | null`

This task has no unit test **by design**: it holds no logic — every decision it could make was moved
into Task 1's tested module, and the repo has no DOM test environment to render a hook in. Adding one
would violate the no-new-dependencies constraint. Its correctness is covered by Task 1's tests plus
the Task 5 visual verification.

- [ ] **Step 1: Write the hook**

Create `packages/web/src/live/useWorkingOn.ts`:

```ts
import type { Envelope, LaneBoard } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchLaneBoard, type LiveConfig } from './client';
import { invalidatesLanes } from './workingOn';

/**
 * The lane board behind the overlay's working-on strap.
 *
 * **No polling.** One fetch when the connection comes up, then a re-fetch only when a lane act
 * arrives on the firehose we are already subscribed to. Lane changes are rare and self-announcing, so
 * idle cost is effectively zero — the ADR 151 contract every /live viewer pays into forever.
 *
 * A failed fetch keeps the previous board (a stale strap beats a flashing one) and is otherwise
 * silent: this is ambient chrome, never an error surface. On a stream there is nobody to tell.
 */
export function useWorkingOn(cfg: LiveConfig | null, envelopes: Envelope[]): LaneBoard | null {
  const [board, setBoard] = useState<LaneBoard | null>(null);
  // The newest envelope we have already reacted to — so a re-render never re-fetches.
  const seenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cfg) {
      setBoard(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLaneBoard(cfg);
        if (!cancelled) setBoard(next);
      } catch {
        /* keep the previous board */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  useEffect(() => {
    if (!cfg || envelopes.length === 0) return;
    const latest = envelopes[envelopes.length - 1];
    if (latest.id === seenRef.current) return;
    seenRef.current = latest.id;
    if (!invalidatesLanes(latest)) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLaneBoard(cfg);
        if (!cancelled) setBoard(next);
      } catch {
        /* keep the previous board */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, envelopes]);

  return board;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm -r build`
Expected: all packages build, no TypeScript errors.

If `envelopes` is ordered newest-first in this codebase rather than oldest-last, read
`packages/web/src/live/useLiveStream.ts` and index the newest end accordingly — the hook must react to
the **newest** envelope.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/useWorkingOn.ts
git add packages/web/src/live/useWorkingOn.ts
git commit -m "feat(web): lane board hook — fetch on connect, refresh on lane acts"
```

---

### Task 3: The overlay component and its styles

**Files:**

- Create: `packages/web/src/live/OfficeOverlay.tsx`
- Modify: `packages/web/src/live/Live.css` (append the overlay block at the end)

**Interfaces:**

- Consumes: `WorkingOnEntry` (Task 1); `type ConnStatus` from `./client`.
- Produces:
  `function OfficeOverlay(props: { teamName: string; present: number; lanes: WorkingOnEntry[]; status: ConnStatus }): JSX.Element`

**Why `Live.css`:** `broadcast.tsx` already links `Live.css` as well as `Broadcast.css`, so `Live.css`
is the stylesheet both routes share. A separate file would add a request to `/live` for no benefit.

**Before writing any markup, invoke the `frontend-design`, `impeccable`, and `emil-design-eng` skills**
— this is nick's standing rule for all musterd frontend work, and this surface is the first musterd UI
a Twitch stranger ever sees.

- [ ] **Step 1: Write the component**

Create `packages/web/src/live/OfficeOverlay.tsx`:

```tsx
import type { ConnStatus } from './client';
import type { WorkingOnEntry } from './workingOn';

/**
 * The office's on-screen chrome — **the same component on `/live` and `/broadcast`**, rendered inside
 * `OfficeScene` so the dashboard and the stream cannot drift apart (nick's standing decision,
 * 2026-07-24).
 *
 * It carries **orientation, not narration**: who this team is, who is in the room, and what they are
 * working on. Acts stay with the speech bubbles. That division matters because the office rests on a
 * still frame between ambient beats — a viewer landing on a motionless room still learns something
 * here, where an act ticker would be blank.
 *
 * Never interactive (`pointer-events: none`), and hidden from assistive tech: every fact it shows is
 * also in the roster rail and the stream, in accessible form.
 */
export function OfficeOverlay({
  teamName,
  present,
  lanes,
  status,
}: {
  teamName: string;
  present: number;
  lanes: WorkingOnEntry[];
  status: ConnStatus;
}) {
  const live = status === 'live';
  return (
    <div className="lc-ov" aria-hidden="true">
      <div className="lc-ov__id">
        <span className="lc-ov__mark" />
        <span className="lc-ov__team">{teamName}</span>
        <span className={`lc-ov__sig${live ? ' is-live' : ''}`}>
          <i className="lc-ov__dot" />
          {live ? 'LIVE' : 'CONNECTING'}
        </span>
        {live && present > 0 && (
          <span className="lc-ov__present">
            {present} <span className="lc-ov__present-unit">in the room</span>
          </span>
        )}
      </div>

      {lanes.length > 0 && (
        <ul className="lc-ov__strap">
          {lanes.map((l, i) => (
            // `key` is the lane id, so React reuses the node across refreshes and only genuinely new
            // chips play the enter animation. Keying by index would replay it on every fetch.
            <li
              key={l.id}
              className={`lc-ov__lane lc-ov__lane--${l.state}`}
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <span className="lc-ov__owner">{l.owner}</span>
              <span className="lc-ov__title">{l.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

Append to `packages/web/src/live/Live.css`:

```css
/* ─── the office overlay (shared by /live and /broadcast) ─────────────────
   Warm, not broadcast-white: the palette is the room's own. Quiet at rest so the office stays the
   star; brief one-shot motion when something actually changes. No loop anywhere in here — the only
   animations are enter transitions, so idle cost stays zero and the 30fps encode stays clean. */

.lc-ov {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--lc-z-overlay);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 clamp(16px, 2.2cqw, 40px) clamp(14px, 1.8cqh, 34px);
  pointer-events: none;
  container-type: inline-size;
  /* Light spilling off the office floor, not a pasted rectangle. */
  background: linear-gradient(to top, rgba(9, 9, 11, 0.72) 0%, rgba(9, 9, 11, 0) 100%);
}

.lc-ov__id {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--font-display);
}

.lc-ov__mark {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--mustard-500);
  box-shadow: 0 0 14px var(--glow-mustard-soft);
}

.lc-ov__team {
  color: var(--text);
  font-size: clamp(15px, 1.35cqw, 26px);
  font-weight: 700;
  letter-spacing: -0.01em;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
}

.lc-ov__sig {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  background: rgba(12, 10, 13, 0.62);
  backdrop-filter: blur(6px);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: clamp(9px, 0.62cqw, 12px);
  letter-spacing: 0.16em;
}

.lc-ov__sig.is-live {
  color: var(--text-dim);
}

.lc-ov__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zinc-500);
}

/* One slow breath on one dot — the whole motion budget for the resting state. */
.lc-ov__sig.is-live .lc-ov__dot {
  background: var(--danger);
  animation: lc-ov-breathe 2.4s var(--ease-in-out) infinite;
}

@keyframes lc-ov-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
  }
  70% {
    box-shadow: 0 0 0 9px rgba(239, 68, 68, 0);
  }
}

.lc-ov__present {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: clamp(9px, 0.62cqw, 12px);
}

.lc-ov__present-unit {
  opacity: 0.7;
}

.lc-ov__strap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-ov__lane {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  padding: 6px 13px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  border-left: 2px solid var(--mustard-500);
  background: rgba(20, 17, 24, 0.66);
  backdrop-filter: blur(8px);
  animation: lc-ov-enter 420ms var(--ease-out) both;
}

.lc-ov__lane--blocked {
  border-left-color: var(--warning);
}

.lc-ov__owner {
  flex: none;
  color: var(--mustard-300);
  font-family: var(--font-mono);
  font-size: clamp(9px, 0.6cqw, 12px);
  letter-spacing: 0.04em;
}

.lc-ov__title {
  overflow: hidden;
  color: var(--text-dim);
  font-family: var(--font-display);
  font-size: clamp(11px, 0.75cqw, 15px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes lc-ov-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Narrow container (the /live office column): the strap keeps one lane, on one line. */
@container (max-width: 520px) {
  .lc-ov__strap {
    flex-wrap: nowrap;
  }
  .lc-ov__lane:not(:first-child) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-ov__sig.is-live .lc-ov__dot,
  .lc-ov__lane {
    animation: none;
  }
}
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm -r build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/OfficeOverlay.tsx packages/web/src/live/Live.css
git add packages/web/src/live/OfficeOverlay.tsx packages/web/src/live/Live.css
git commit -m "feat(web): OfficeOverlay — shared on-screen office chrome"
```

---

### Task 4: Wire it into the scene and both routes

**Files:**

- Modify: `packages/web/src/live/OfficeScene.tsx`
- Modify: `packages/web/src/routes/broadcast.tsx:133` (delete `BroadcastOverlay`, lines 139-163)
- Modify: `packages/web/src/routes/live.tsx:228-237` (topbar) and `:267-275` (scene props)
- Modify: `packages/web/src/live/Broadcast.css:42-118` (delete placeholder overlay styles)

**Interfaces:**

- Consumes: `OfficeOverlay` (Task 3), `useWorkingOn` (Task 2), `workingOn` + `presentCount` (Task 1).
- Produces: `OfficeScene` gains two optional props — `lanes?: WorkingOnEntry[]` and `status?: ConnStatus`.

- [ ] **Step 1: Add the overlay to the scene**

In `OfficeScene.tsx`, add to the props type (after `broadcast`):

```tsx
  /** The working-on strap's lanes, already derived by the route (see `workingOn`). */
  lanes?: WorkingOnEntry[];
  /** Connection state, for the overlay's honest LIVE/CONNECTING signal. */
  status?: ConnStatus;
```

Import at the top:

```tsx
import type { ConnStatus } from './client';
import { OfficeOverlay } from './OfficeOverlay';
import { presentCount, type WorkingOnEntry } from './workingOn';
```

Destructure `lanes = []` and `status = 'idle'` alongside the existing props, then render
`<OfficeOverlay>` as the **last child inside the same element that hosts the canvas and the name
labels** (the element `hostRef`/`labelRef` sit in), so it shares their stacking context:

```tsx
<OfficeOverlay teamName={teamName} present={presentCount(roster)} lanes={lanes} status={status} />
```

Render it only when not collapsed — `{!collapsed && <OfficeOverlay … />}` — since a collapsed office
panel on `/live` has no room for it.

- [ ] **Step 2: Wire `/broadcast`**

In `broadcast.tsx`: import `useWorkingOn` and `workingOn`, derive lanes after the `useLiveStream`
call, pass them to `OfficeScene`, and **delete** both the `<BroadcastOverlay …/>` element and the
whole `BroadcastOverlay` function (lines 139-163).

```tsx
const board = useWorkingOn(cfg, envelopes);
const lanes = workingOn(board, 3);
```

```tsx
<OfficeScene
  teamName={team}
  roster={roster}
  envelopes={envelopes}
  liveIds={liveIds}
  lanes={lanes}
  status={status}
  broadcast
  onReady={onSceneReady}
/>
```

Keep the `error` state and its `recoverObserver` path exactly as they are — the overlay does not
render errors, and self-healing must not regress. Delete the now-unused `error` **display** only; if
TypeScript flags `error` as unused after the delete, render it as a small `.bc__error` div directly in
the stage rather than deleting the state.

- [ ] **Step 3: Wire `/live` and reduce the topbar**

In `live.tsx`: derive lanes the same way and pass `lanes` + `status` to `OfficeScene`. Then delete
these two lines from the topbar (they are now duplicated by the overlay, a few inches apart — nick
approved the reduction 2026-07-24):

```tsx
{
  connected && <span className="lc__team">/ {cfg!.team}</span>;
}
<StatusPill status={status} live={roster.filter((m) => m.presence !== 'offline').length} />;
```

Keep `MusterdWord`, `WatchLinkButton`, `CompanionToggle`, `SoundToggle`, `Clock` — the topbar is now
purely operator chrome. Remove the `StatusPill` import if nothing else uses it; if `StatusPill` is
defined in this file and now unreferenced, delete its definition too.

- [ ] **Step 4: Delete the placeholder styles**

In `Broadcast.css`, delete everything from the `/* ─── the on-stream overlay …` comment (line 42) to
the end of file, then re-add only the reduced-motion note if the file would otherwise end mid-comment.
`Broadcast.css` keeps the stage and letterbox rules only.

- [ ] **Step 5: Verify the whole workspace builds and tests pass**

Run from the repo root:

```bash
pnpm -r build && pnpm test
```

Expected: build clean; all tests pass (existing suites plus Task 1's).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/OfficeScene.tsx packages/web/src/routes/broadcast.tsx packages/web/src/routes/live.tsx packages/web/src/live/Broadcast.css
git add packages/web/src/live/OfficeScene.tsx packages/web/src/routes/broadcast.tsx packages/web/src/routes/live.tsx packages/web/src/live/Broadcast.css
git commit -m "feat(web): render the shared overlay on /live and /broadcast

Replaces the placeholder BroadcastOverlay and drops the now-duplicate
team name + status pill from the /live topbar."
```

---

### Task 5: Verify it on the real stream, then gate

**Files:** none created; this task proves the work.

- [ ] **Step 1: Check the perf budget**

Run: `pnpm perf:check`
Expected: PASS. If CSS gzip trips the budget, first shrink the change. Raising the budget is allowed
but must be done in this PR **and** logged with the measured cost in
`docs/perf/web-live-baseline.md` (ADR 151).

- [ ] **Step 2: Look at `/live` in a real browser**

Serve the built bundle — `vite preview` from `packages/web`, **never** `vite dev` (the daemon serves
the published bundle; dev mode does not reflect what ships). Confirm: overlay bottom-anchored over the
office, one lane chip in the narrow column, no horizontal scroll, topbar no longer shows a duplicate
team name or status pill.

- [ ] **Step 3: Capture the broadcast exactly as the encoder sees it**

```bash
node /Users/nick/agents/packages/cli/dist/bin.js broadcast --team revive --out /tmp/overlay.mp4 --duration 25
```

Watch `/tmp/overlay.mp4`. Confirm at 1:1 **and** scaled down to phone size: the team, the LIVE dot,
and the lane strap are all legible; chips are not clipped; the strap is still informative during a
**resting room** (wait for a gap between ambient beats). Check the ffmpeg `-stats` line still reports
`speed=1x` — the overlay must not cost frame budget.

- [ ] **Step 4: Run every gate**

```bash
pnpm -r build && pnpm test && pnpm lint && pnpm format:check && pnpm perf:check
```

Expected: all pass. `lint` and `format:check` are separate gates from the build; run the build first.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/broadcast-overlay
gh pr create --title "feat(web): shared office overlay for /live and /broadcast" --body "…"
gh pr merge --squash --auto --delete-branch
```

Per ADR 106. If Bugbot never registers as a required check, comment `bugbot run` on the PR (~90s).

- [ ] **Step 6: Resolve the lane**

```bash
node /Users/nick/agents/packages/cli/dist/bin.js lane resolve 01KYAQTX667WF17C5DBE821SR0
```

Then delete `HANDOFF-broadcast-overlay.md` (untracked; it was never to be committed) and return to the
parked `/board` lane `01KY5CYNZ609TJP1JT9K62MQYG`.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: `OfficeOverlay` → Task 3; `useWorkingOn` → Tasks
1-2; topbar reduction → Task 4 Step 3; layout across two boxes → Task 3's container query; look and
feel → Task 3 styles + skill invocation; disclosure → Global Constraints (explicitly "do not fix");
testing → Task 1 tests + Task 5 visual verification.

**Placeholders.** None — every step carries real code or a real command.

**Type consistency.** `WorkingOnEntry` fields (`id`, `title`, `owner`, `state`) are identical in Tasks
1, 3, 4. `workingOn(board, limit)`, `presentCount(roster)`, `invalidatesLanes(env)`, and
`useWorkingOn(cfg, envelopes)` keep the same signatures throughout. `ConnStatus` is imported from
`./client`, where it is defined (client.ts:36).

**One deviation from the spec, deliberate:** the spec called for a mustard spark when a lane resolves.
A resolved lane leaves the board on the next fetch, so an exit animation would need the component to
hold departing entries — state, and a timer, in a component the spec requires to be effect-free. It is
cut. If the leaving feels abrupt in Task 5's capture, it comes back as its own small lane with a
CSS-only approach, not as timer state here.
