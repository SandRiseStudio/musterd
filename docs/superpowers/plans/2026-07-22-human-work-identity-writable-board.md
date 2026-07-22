# Human work identity — writable board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Implementation owner: miley** (all `packages/web`). **Spec:**
[docs/superpowers/specs/2026-07-22-human-work-identity-writable-board-design.md](../specs/2026-07-22-human-work-identity-writable-board-design.md).

**Goal:** Make the `/board` kanban writable by a signed-in human member — create/claim/advance/handoff/
resolve lanes from the web — so nick can own a real `publish-to-npm` lane from the browser; then round
the board out with an insight rail + Goal swimlanes and live-tail.

**Architecture:** The backend is already complete (`POST /lanes`, `PATCH /lanes/:id`, `GET /report`,
all member-authed). This is web-only: add two client functions mirroring `sendAct`, teach `/board` the
existing `/live` member sign-in (extracted to a shared component), and render write controls gated on
real roster membership. Writes apply optimistically (the daemon echo is the only copy the sender sees)
and reconcile on live-tail. Increments A (write) → B (insight rail + swimlanes) → C (live-tail).

**Tech Stack:** React + TanStack Router, TypeScript, Vitest, the musterd web client
(`packages/web/src/live/client.ts`), shared `@musterd/protocol` schemas.

## Global Constraints

- **Implementation owner is miley; all changes are in `packages/web`.** Do not touch server/protocol —
  the backend contract is fixed and complete.
- **No new work-item nouns** (ADR 098: Goal → Lane). The board renders what the daemon derives; never a
  second store.
- **Member-authed writes only.** Every write uses the signed-in seat's `mscr_` as `Bearer` +
  `x-musterd-surface: web`. Controls render only when `roster.some(m => m.name === cfg.as)` is true.
- **Perf gate is hard** (ADR 151, `pnpm perf:check`): no new heavy deps; animation/render loops stop
  when unseen; no unbounded DOM; three font families only (Fraunces / Space Grotesk / Space Mono). Any
  budget raise is a same-PR act logged in `docs/perf/web-live-baseline.md`.
- **Design & branding bar is a first-class requirement.** Every new control/form/card/rail/transition
  must be magical, fun, warm, quirky, intuitive, smooth, sleek, responsive, beautiful, delightful —
  grounded in `src/styles/tokens.css`, `src/brand/` (ADR 154), and the office aesthetic (ADR
  079/086/096, theme-aware light default). Invoke the `frontend-design`, `impeccable`, and
  `emil-design-eng` skills. Reduced-motion parity mandatory; fully responsive.
- **Tests run from the repo root** (`pnpm --filter @musterd/web test`). Follow the existing web-client
  test pattern in `packages/web/src/live/client.test.ts`.

---

## Increment A — member sign-in + write (ships the nick dogfood)

### Task A1: Extract the shared `<MemberSignIn>` component

Pull the "Advanced — connect as a specific seat" fields (currently inline in `ConnectForm`,
`live.tsx:459-489`) into a reusable component so `/live` and `/board` share one sign-in. No behavior
change on `/live`.

**Files:**
- Create: `packages/web/src/live/MemberSignIn.tsx`
- Modify: `packages/web/src/routes/live.tsx` (ConnectForm consumes the new component)
- Test: `packages/web/src/live/MemberSignIn.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface AdvancedState { open: boolean; as: string; token: string }
  export function MemberSignIn(props: {
    advanced: AdvancedState;
    onAdvanced: (a: AdvancedState) => void;
  }): JSX.Element
  ```
  Renders the toggle button plus, when `advanced.open`, the "Observe as (seat)" text input and the
  "Credential" password input — the exact markup/classes from `live.tsx:459-489` (`lc-form__field`,
  `lc-form__advanced`).

- [ ] **Step 1: Write the failing test**

```tsx
// MemberSignIn.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemberSignIn } from './MemberSignIn';

describe('MemberSignIn', () => {
  it('hides the seat/credential fields until opened', () => {
    render(<MemberSignIn advanced={{ open: false, as: '', token: '' }} onAdvanced={vi.fn()} />);
    expect(screen.queryByPlaceholderText('your seat name')).toBeNull();
    expect(screen.getByText('Advanced — connect as a specific seat')).toBeTruthy();
  });

  it('shows seat + credential fields when open and reports edits', () => {
    const onAdvanced = vi.fn();
    render(<MemberSignIn advanced={{ open: true, as: '', token: '' }} onAdvanced={onAdvanced} />);
    fireEvent.change(screen.getByPlaceholderText('your seat name'), { target: { value: 'nick' } });
    expect(onAdvanced).toHaveBeenCalledWith({ open: true, as: 'nick', token: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @musterd/web test MemberSignIn`
Expected: FAIL — `MemberSignIn` not exported.

- [ ] **Step 3: Implement `MemberSignIn.tsx`**

Move the `AdvancedState` shape and the JSX from `ConnectForm` (the `{advanced.open && (…)}` block plus
the `lc-form__advanced` toggle button) verbatim into the component. Keep every class name.

- [ ] **Step 4: Rewire `ConnectForm` in `live.tsx`**

Replace the inline advanced block + toggle with `<MemberSignIn advanced={advanced} onAdvanced={onAdvanced} />`.
Import `AdvancedState` from `./MemberSignIn` and use it for the `advanced` prop type (replacing the
inline `{ open; as; token }` literal).

- [ ] **Step 5: Run the web tests + typecheck**

Run: `pnpm --filter @musterd/web test && pnpm --filter @musterd/web typecheck`
Expected: PASS (existing `/live` tests unchanged; new `MemberSignIn` tests pass).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/MemberSignIn.tsx packages/web/src/live/MemberSignIn.test.tsx packages/web/src/routes/live.tsx
git commit -m "refactor(web): extract shared MemberSignIn from /live ConnectForm"
```

### Task A2: `createLane` + `updateLane` client functions

**Files:**
- Modify: `packages/web/src/live/client.ts` (add after `sendAct`)
- Test: `packages/web/src/live/client.test.ts`

**Interfaces:**
- Consumes: `OpenLane`, `UpdateLane`, `Lane` from `@musterd/protocol`; `LiveConfig`, `LiveFetchError`
  from `./client`.
- Produces:
  ```ts
  export function createLane(cfg: LiveConfig, input: OpenLane): Promise<Lane>   // POST /teams/:slug/lanes → { lane }
  export function updateLane(cfg: LiveConfig, id: string, input: UpdateLane): Promise<Lane> // PATCH /teams/:slug/lanes/:id → { lane }
  ```
  Both send `authorization: Bearer ${cfg.token}`, `content-type: application/json`,
  `x-musterd-surface: web`; both throw `LiveFetchError(message, code, status)` on `!res.ok` (same
  error-unwrap as `sendAct`); both return the `lane` off the JSON body.

- [ ] **Step 1: Write the failing tests** (stub `global.fetch`, mirroring how a fetch-based client is unit-tested)

```ts
// append to client.test.ts
import { createLane, updateLane, LiveFetchError } from './client';

const cfg = { team: 'revive', as: 'nick', token: 'mscr_x' };
const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) } as Response);
const errJson = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, text: () => Promise.resolve(JSON.stringify({ error: { code, message } })) } as Response);

describe('createLane', () => {
  it('POSTs to /teams/:slug/lanes as the signed-in member and returns the lane', async () => {
    const fetchMock = vi.fn().mockReturnValue(okJson({ lane: { id: 'L1', title: 'publish to npm', owner_seat: 'nick' } }));
    vi.stubGlobal('fetch', fetchMock);
    const lane = await createLane(cfg, { title: 'publish to npm', claim: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/teams/revive/lanes');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer mscr_x');
    expect(init.headers['x-musterd-surface']).toBe('web');
    expect(JSON.parse(init.body)).toEqual({ title: 'publish to npm', claim: true });
    expect(lane.owner_seat).toBe('nick');
    vi.unstubAllGlobals();
  });

  it('throws a LiveFetchError carrying the daemon code on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(errJson(403, 'forbidden', 'observers cannot write')));
    await expect(createLane(cfg, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    vi.unstubAllGlobals();
  });
});

describe('updateLane', () => {
  it('PATCHes /teams/:slug/lanes/:id and returns the updated lane', async () => {
    const fetchMock = vi.fn().mockReturnValue(okJson({ lane: { id: 'L1', state: 'active', owner_seat: 'nick' } }));
    vi.stubGlobal('fetch', fetchMock);
    const lane = await updateLane(cfg, 'L1', { state: 'active' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/teams/revive/lanes/L1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ state: 'active' });
    expect(lane.state).toBe('active');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web test client`
Expected: FAIL — `createLane`/`updateLane` not exported.

- [ ] **Step 3: Implement the two functions in `client.ts`**

```ts
import type { Lane, OpenLane, UpdateLane } from '@musterd/protocol';

/** Create a lane from the browser as the signed-in member (item 5). Member-authed POST — a browser
 *  create is indistinguishable from a CLI one to the daemon. `claim:true` stamps owner_seat = me. */
export async function createLane(cfg: LiveConfig, input: OpenLane): Promise<Lane> {
  const res = await fetch(`/teams/${encodeURIComponent(cfg.team)}/lanes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'x-musterd-surface': 'web' },
    body: JSON.stringify(input),
  });
  return laneFromResponse(res);
}

/** Update a lane (claim / advance state / handoff / resolve) as the signed-in member. */
export async function updateLane(cfg: LiveConfig, id: string, input: UpdateLane): Promise<Lane> {
  const res = await fetch(`/teams/${encodeURIComponent(cfg.team)}/lanes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'x-musterd-surface': 'web' },
    body: JSON.stringify(input),
  });
  return laneFromResponse(res);
}

async function laneFromResponse(res: Response): Promise<Lane> {
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(err?.message ?? `HTTP ${res.status}`, err?.code ?? `http_${res.status}`, res.status);
  }
  return (json as { lane: Lane }).lane;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/web test client && pnpm --filter @musterd/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/client.ts packages/web/src/live/client.test.ts
git commit -m "feat(web): createLane/updateLane member-authed client fns (item 5)"
```

### Task A3: `/board` grows member sign-in + roster + a write-capability flag

Teach the board route to accept the advanced member sign-in and know whether the connected seat can
write. Read-only observer behavior is preserved when not signed in as a member.

**Files:**
- Modify: `packages/web/src/routes/board.tsx`
- Test: manual (Step 5) — route wiring; the gating *logic* is a pure helper tested in Task A4.

**Interfaces:**
- Consumes: `MemberSignIn`, `AdvancedState` (Task A1); `fetchRoster`, `createLane`, `updateLane`
  (Tasks A2 / existing client); `acquireObserver`.
- Produces: a `canWrite: boolean` in `BoardPage` = `cfg != null && roster.some(m => m.name === cfg.as)`,
  threaded into `<Board>` (Task A4).

- [ ] **Step 1: Add advanced state + roster to `BoardPage`**

Add `const [advanced, setAdvanced] = useState<AdvancedState>({ open: false, as: '', token: '' })` and
`const [roster, setRoster] = useState<MemberSummary[]>([])`. In `connect()`, before `acquireObserver`,
branch exactly like `live.tsx:126-127`:

```ts
let c: LiveConfig;
if (advanced.open && advanced.as.trim() && advanced.token.trim()) {
  c = { team: slug, as: advanced.as.trim(), token: advanced.token.trim() };
} else {
  c = await acquireObserver(slug);
}
```

Then `setRoster(await fetchRoster(c))` alongside the existing `load(c)` (a member needs the roster to
evaluate the gate; the observer fetch is harmless).

- [ ] **Step 2: Render `<MemberSignIn>` in the connect form**

Add `<MemberSignIn advanced={advanced} onAdvanced={setAdvanced} />` inside the `lc-form__card`, below
the Team field — same placement as `/live`.

- [ ] **Step 3: Compute + thread `canWrite`**

```ts
const canWrite = cfg != null && roster.some((m) => m.name === cfg.as);
// …
<Board lanes={lanes} warnings={warnings} canWrite={canWrite} cfg={cfg!} roster={roster}
       onLanes={setLanes} />
```

(`onLanes`, `canWrite`, `cfg`, `roster` are consumed in Task A4.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @musterd/web typecheck`
Expected: PASS (Task A4 adds the `Board` props; if running A3 alone, temporarily accept the prop-type
error until A4 lands — these two tasks ship together).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/board.tsx
git commit -m "feat(web): /board accepts member sign-in + roster; derives canWrite (item 5)"
```

### Task A4: Write controls on the board — create, claim, advance, handoff, resolve

Add the write affordances to `Board.tsx`, gated on `canWrite`, applied optimistically via the daemon
echo. Extract the pure state-machine helper so it is unit-testable.

**Files:**
- Modify: `packages/web/src/live/Board.tsx`
- Create: `packages/web/src/live/boardWrite.ts` (pure helpers: next-state, optimistic merge)
- Test: `packages/web/src/live/boardWrite.test.ts`

**Interfaces:**
- Consumes: `createLane`, `updateLane` (Task A2); `Lane`, `LaneState` from `@musterd/protocol`.
- Produces:
  ```ts
  export const NEXT_STATE: Partial<Record<LaneState, LaneState>>; // claimed→active, active→done (blocked handled separately)
  export function advanceTarget(state: LaneState): LaneState | null;
  export function mergeLane(lanes: Lane[], updated: Lane): Lane[]; // replace by id, or append if new
  ```

- [ ] **Step 1: Write the failing test for the pure helpers**

```ts
// boardWrite.test.ts
import { describe, expect, it } from 'vitest';
import { advanceTarget, mergeLane, NEXT_STATE } from './boardWrite';

describe('advanceTarget', () => {
  it('walks claimed → active → done', () => {
    expect(advanceTarget('claimed')).toBe('active');
    expect(advanceTarget('active')).toBe('done');
  });
  it('has no advance from a terminal or backlog state', () => {
    expect(advanceTarget('done')).toBeNull();
    expect(advanceTarget('open')).toBe('claimed'); // picking up backlog = claim+work
  });
});

describe('mergeLane', () => {
  it('replaces an existing lane by id', () => {
    const out = mergeLane([{ id: 'L1', state: 'claimed' } as any], { id: 'L1', state: 'active' } as any);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('active');
  });
  it('appends a newly-created lane', () => {
    const out = mergeLane([], { id: 'L2', state: 'claimed' } as any);
    expect(out.map((l) => l.id)).toEqual(['L2']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web test boardWrite`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `boardWrite.ts`**

```ts
import type { Lane, LaneState } from '@musterd/protocol';

export const NEXT_STATE: Partial<Record<LaneState, LaneState>> = {
  open: 'claimed',
  claimed: 'active',
  active: 'done',
  blocked: 'active', // unblock
};
export function advanceTarget(state: LaneState): LaneState | null {
  return NEXT_STATE[state] ?? null;
}
export function mergeLane(lanes: Lane[], updated: Lane): Lane[] {
  const i = lanes.findIndex((l) => l.id === updated.id);
  if (i === -1) return [...lanes, updated];
  const next = lanes.slice();
  next[i] = updated;
  return next;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/web test boardWrite`
Expected: PASS.

- [ ] **Step 5: Add the write UI to `Board.tsx`**

Extend `Board` props with `canWrite: boolean; cfg: LiveConfig; roster: MemberSummary[]; onLanes: (l:
Lane[]) => void`. When `canWrite`:
- A **"+ New lane"** button in the header opens a compact form (title required; optional Goal/project/
  surface/branch; a **"claim it" toggle default on**). On submit: `const lane = await createLane(cfg,
  {title, claim, …}); onLanes(mergeLane(lanes, lane))`.
- Per-card controls, shown by ownership/state:
  - unowned → **claim**: `updateLane(cfg, id, { owner_seat: cfg.as })`.
  - owned-by-me + `advanceTarget(state)` non-null → **advance** (label from target): `updateLane(cfg,
    id, { state: advanceTarget(state)! })`; a **block** toggle sets `{ state: 'blocked' }`.
  - owned-by-me → **hand off** (pick a roster seat): `updateLane(cfg, id, { owner_seat: other })`.
  - owned-by-me → **resolve** (`done` / `abandoned`): `updateLane(cfg, id, { state })`.
  - Each on success: `onLanes(mergeLane(lanes, updated))` (optimistic; reconciles on Inc C live-tail).
  - On error, surface the `LiveFetchError.message` inline and leave the board unchanged.
- When `!canWrite`, render nothing new — the board is byte-for-byte today's read-only view.

Apply the **design & branding bar** here (global constraints): on-brand tokens, delightful "New lane"
moment, smooth card transitions, tasteful empty states, reduced-motion parity, responsive. Invoke
`frontend-design` / `impeccable` / `emil-design-eng`.

- [ ] **Step 6: Typecheck + web tests + perf gate**

Run: `pnpm --filter @musterd/web typecheck && pnpm --filter @musterd/web test && pnpm --filter @musterd/web build && pnpm perf:check`
Expected: PASS; `perf:check` within budget (if a raise is unavoidable, log it in
`docs/perf/web-live-baseline.md` in this commit).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/live/Board.tsx packages/web/src/live/boardWrite.ts packages/web/src/live/boardWrite.test.ts
git commit -m "feat(web): writable board — create/claim/advance/handoff/resolve, optimistic (item 5)"
```

### Task A5: Dogfood acceptance + design/reduced-motion/responsive verification

The quality gate before the PR: prove the nick dogfood works end-to-end and the aesthetic bar is met.

**Files:** none (verification); fixes land in the task they belong to.

- [ ] **Step 1: End-to-end dogfood against a temp daemon**

Follow the temp-daemon recipe at the top of `docs/perf/web-live-baseline.md`. `vite preview` the built
web (never `vite dev`). Sign in on `/board?team=<team>` via Advanced as a real member seat with its
`mscr_`. Create a lane titled "publish packages to npm", claim-it on. Verify: the card appears in
`claimed`, `owner_seat` is that member, and `GET /lanes` shows it. Claim/advance/handoff/resolve a
throwaway lane; confirm each persists.

- [ ] **Step 2: Observer read-only regression**

Load `/board` with the auto observer (no Advanced). Verify zero write controls appear and the view
matches today's read-only board.

- [ ] **Step 3: Design, responsive, reduced-motion pass**

With `frontend-design` / `impeccable`: verify the board reads as magical/warm/on-brand (not a sterile
table), transitions are smooth, empty + "New lane" states delight, layout is responsive across
viewport widths, and `prefers-reduced-motion` disables non-essential motion. Screenshot via headless
Chrome to self-verify.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(web): writable board — human work identity, Inc A (item 5)" --body "<summary + spec link + dogfood evidence>"
gh pr merge --squash --auto --delete-branch
```

---

## Increment B — insight rail + Goal swimlanes (own plan when A lands)

Outline (expand into `2026-07-…-writable-board-inc-b.md` after Inc A merges):

- **B1:** `fetchReport(cfg): Promise<Report>` in `client.ts` → `GET /teams/:slug/report`, validated with
  `ReportSchema.parse` at the boundary (mirror `fetchLaneBoard`). Unit-test request shape + parse.
- **B2:** `<InsightRail report={report} />` — collapsible right rail rendering `flow` (throughput/cycle/
  WIP/oldest-age), `waiting_on` (the "waiting on nick — N threads, oldest Xd" line), `blocked`,
  `coordination` (only when flagged); MAST/steering/wake behind a "more" disclosure. DOM-light.
- **B3:** Goal swimlane view toggle on `Board` — columns ⇄ swimlanes (one row per `report.goals` entry
  with derived status; "no goal" row last). Pure regroup of lanes + goals; unit-test the grouping helper.
- Perf-check; design bar applies.

## Increment C — live-tail (own plan when B lands)

Outline:

- **C1:** Reuse `LiveClient` (subscribe `team-all`) on `/board`; on ADR 102 lane envelopes
  (`lane_open`/`lane_claim`/`lane_state`/`lane_handoff`/`lane_resolve` meta), patch the affected card via
  `mergeLane` — no refetch. Reconciles the Inc A optimistic writes (echo settles when the authoritative
  event arrives). Refresh remains the socket-down fallback.
- **C2:** Ensure the WS reuses the existing 15s heartbeat, no new rAF/interval loops (perf gate); board
  DOM stays bounded by lane count.
- Perf-check; design bar applies.

## Self-review notes

- **Spec coverage:** identity model → A1/A3; write (create/claim/advance/handoff/resolve) → A2/A4;
  optimistic apply → A4 (`mergeLane`) + reconcile in C1; insight rail + swimlanes → B; live-tail → C;
  design bar → global constraint + A4/A5; perf → every build step + A4/A5; dogfood → A5.
- **No new nouns / member-authed / observer-preserved** enforced in global constraints and A4 gating.
- **Type consistency:** `createLane`/`updateLane`/`mergeLane`/`advanceTarget`/`fetchReport` names are
  used identically wherever referenced across tasks.
