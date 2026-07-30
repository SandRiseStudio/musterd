# Office Presence Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put identity (harness · model · role) on floating nameplates, show work + progress as a hybrid cue with an in-panel stack fallback, replace the wall color-chip pinboard with an orange-on-white dry-erase board, and remove the bottom WHO’S IN rail.

**Architecture:** Pure display helpers in `presenceLabel.ts` (unit-tested). `OfficeNode` carries surface/model/work fields from `OfficeScene.computeData`. DOM `.lc-gl-label` gains identity + truncated work lines (hover tip for full read). Canvas `wallRoster` becomes static `wallWhiteboard` set dressing. `/live` drops `OfficeBoard` and hides `OfficeOverlay`; `/broadcast` keeps a passive overlay if needed.

**Tech Stack:** React 19 + TypeScript, canvas office scene, vitest (node), plain CSS tokens. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-07-30-office-presence-chrome-design.md](../specs/2026-07-30-office-presence-chrome-design.md)

**Lane:** `01KYT03N99822SPBN0Q9HH883T` · branch `feat/office-presence-chrome`  
**Note:** Advisory surface overlap with older lane `01KYR3YWBYQPBW32BXEBZFR8N1` (same `packages/web/src/live/**`). Before coding, release or park that lane if it is stale so this lane is the sole owner.

## Global Constraints

- **No new runtime dependencies** without an ADR (`packages/web/AGENTS.md`).
- **Fonts:** Inter, Space Grotesk, Space Mono only (`docs/perf/budgets.json` is authority).
- **`pnpm perf:check` must pass.** Raising a budget requires logging in `docs/perf/web-live-baseline.md` (ADR 151 / 183).
- **Animation/rAF loops stop when unseen.** Do not add a new render loop for labels; DOM + CSS only.
- **Tests are `.test.ts`, environment `node`.** No jsdom / testing-library — test pure functions; canvas tests use the existing mock-ctx pattern in `render.test.ts`.
- **No protocol / schema changes.** Surface, model, role, lane state already exist on the wire.
- **Whiteboard ink:** board surface white; marker ink musterd orange `#E1AD01` (`mustard-500`).
- **Progress = lane state**, not a percentage.
- Run `pnpm exec prettier --write <files>` — never `pnpm format`.
- Vitest from **repo root**. Fast gates before push: `pnpm typecheck && pnpm format:check`.
- Seat trailer on commits: `Co-authored-by: miley <miley@revive.musterd>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/web/src/live/presenceLabel.ts` (create) | Short surface/model, identity line, work truncate, short lane-state labels |
| `packages/web/src/live/presenceLabel.test.ts` (create) | Unit tests for the above |
| `packages/web/src/live/office-scene/types.ts` (modify) | `OfficeNode` gains `surface`, `model`, work fields |
| `packages/web/src/live/OfficeScene.tsx` (modify) | Merge roster + `RoomEntry` into nodes; gate overlay; drop band usage |
| `packages/web/src/live/office-scene/index.ts` (modify) | `syncLabels` builds identity + work DOM; hover tip; pointer-events on /live |
| `packages/web/src/live/Live.css` (modify) | Nameplate meta/work/tip styles; delete `.lc-notice*`; optional work-stack |
| `packages/web/src/live/office-scene/render.ts` (modify) | Replace `wallRoster` with `wallWhiteboard` |
| `packages/web/src/live/office-scene/render.test.ts` (modify) | Whiteboard tests replace pinboard roster assertions |
| `packages/web/src/live/WorkStack.tsx` (create) | Fallback A — present & working list for `bandSlot` |
| `packages/web/src/routes/live.tsx` (modify) | Remove `OfficeBoard`; hybrid default / optional `WorkStack` |
| `packages/web/src/live/OfficeBoard.tsx` (delete) | Bottom WHO’S IN rail |
| `packages/web/src/live/OfficeOverlay.tsx` (modify) | Keep for `/broadcast`; `/live` stops rendering it |

---

### Task 1: Pure presence / work label helpers

**Files:**
- Create: `packages/web/src/live/presenceLabel.ts`
- Test: `packages/web/src/live/presenceLabel.test.ts`

**Interfaces:**
- Consumes: `LaneState`, `Surface` (or `string`) from `@musterd/protocol`
- Produces:
  - `shortSurface(surface: string | null | undefined): string`
  - `shortModel(model: string | null | undefined): string`
  - `identityMeta(opts: { surface?: string | null; model?: string | null; role?: string | null }): { line: string | null; title: string }`
  - `truncateWork(title: string, maxChars?: number): string` (default 32)
  - `shortLaneState(state: LaneState | null | undefined): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  identityMeta,
  shortLaneState,
  shortModel,
  shortSurface,
  truncateWork,
} from './presenceLabel';

describe('shortSurface', () => {
  it('maps known harnesses to compact labels', () => {
    expect(shortSurface('claude-code')).toBe('claude');
    expect(shortSurface('cursor')).toBe('cursor');
    expect(shortSurface('codex')).toBe('codex');
    expect(shortSurface('cli')).toBe('cli');
    expect(shortSurface('web')).toBe('web');
  });
  it('returns empty for missing', () => {
    expect(shortSurface(null)).toBe('');
    expect(shortSurface(undefined)).toBe('');
  });
});

describe('shortModel', () => {
  it('shortens common model ids into glanceable labels', () => {
    expect(shortModel('claude-opus-4-5')).toMatch(/opus/i);
    expect(shortModel('gpt-5.6-luna-medium')).toMatch(/gpt/i);
    expect(shortModel('grok-4.5')).toMatch(/grok/i);
  });
  it('returns empty when unattested', () => {
    expect(shortModel(null)).toBe('');
    expect(shortModel('unknown')).toBe('');
  });
});

describe('identityMeta', () => {
  it('joins surface · model when both present', () => {
    const m = identityMeta({ surface: 'cursor', model: 'grok-4.5' });
    expect(m.line).toBe('cursor · grok 4.5'); // exact string after shortModel rules
    expect(m.title).toContain('cursor');
    expect(m.title).toContain('grok-4.5');
  });
  it('omits the line when both surface and model are empty', () => {
    expect(identityMeta({}).line).toBeNull();
  });
  it('appends role to title always, and to line when set', () => {
    const m = identityMeta({ surface: 'cli', model: null, role: 'backend' });
    expect(m.line).toContain('backend');
    expect(m.title).toContain('backend');
  });
});

describe('truncateWork', () => {
  it('leaves short titles alone', () => {
    expect(truncateWork('ship it')).toBe('ship it');
  });
  it('ellipsis long titles at maxChars', () => {
    const t = truncateWork('a'.repeat(40), 32);
    expect(t.length).toBe(32);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('shortLaneState', () => {
  it('maps in-flight states to short chips', () => {
    expect(shortLaneState('active')).toBe('active');
    expect(shortLaneState('blocked')).toBe('blocked');
    expect(shortLaneState('claimed')).toBe('claimed');
    expect(shortLaneState('ready_for_review')).toBe('review');
  });
  it('returns null for done/abandoned/null', () => {
    expect(shortLaneState('done')).toBeNull();
    expect(shortLaneState(null)).toBeNull();
  });
});
```

Adjust expected `shortModel` strings in the test to match the implementation rules you pick in Step 3 — keep them glanceable (`opus 5`, `gpt 5.6`, `grok 4.5`), not raw ids.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/web/src/live/presenceLabel.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `presenceLabel.ts`**

```ts
import type { LaneState } from '@musterd/protocol';

const SURFACE_SHORT: Record<string, string> = {
  'claude-code': 'claude',
  cursor: 'cursor',
  codex: 'codex',
  cli: 'cli',
  web: 'web',
  ios: 'ios',
  slack: 'slack',
  other: 'other',
};

export function shortSurface(surface: string | null | undefined): string {
  if (!surface) return '';
  return SURFACE_SHORT[surface] ?? surface;
}

/** Glanceable model label — prefer family + version crumb over raw id. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  const raw = model.trim();
  if (!raw || raw.toLowerCase() === 'unknown') return '';
  const lower = raw.toLowerCase();
  // Opus / Sonnet / Haiku crumbs
  const anthropic = lower.match(/\b(opus|sonnet|haiku)[- ]?(\d+(?:\.\d+)?)/);
  if (anthropic) return `${anthropic[1]} ${anthropic[2]}`;
  // gpt-5.6-… → gpt 5.6
  const gpt = lower.match(/\bgpt[- ]?(\d+(?:\.\d+)?)/);
  if (gpt) return `gpt ${gpt[1]}`;
  // grok-4.5 → grok 4.5
  const grok = lower.match(/\bgrok[- ]?(\d+(?:\.\d+)?)/);
  if (grok) return `grok ${grok[1]}`;
  // fallback: first two hyphen segments, spaces
  return lower.split('-').slice(0, 2).join(' ').slice(0, 18);
}

export function identityMeta(opts: {
  surface?: string | null;
  model?: string | null;
  role?: string | null;
}): { line: string | null; title: string } {
  const surf = shortSurface(opts.surface);
  const mod = shortModel(opts.model);
  const role = opts.role?.trim() ?? '';
  const parts = [surf, mod].filter(Boolean);
  let line = parts.length ? parts.join(' · ') : null;
  if (role) line = line ? `${line} · ${role}` : role;
  const titleParts = [
    opts.surface ?? null,
    opts.model && opts.model !== 'unknown' ? opts.model : null,
    role || null,
  ].filter(Boolean);
  return { line, title: titleParts.join(' · ') };
}

export function truncateWork(title: string, maxChars = 32): string {
  const t = title.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function shortLaneState(state: LaneState | null | undefined): string | null {
  switch (state) {
    case 'claimed':
      return 'claimed';
    case 'active':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'ready_for_review':
      return 'review';
    case 'open':
    case 'done':
    case 'abandoned':
    case undefined:
    case null:
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
```

If `LaneState` has more variants, extend the switch exhaustively (typescript-exhaustive-switch rule).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/web/src/live/presenceLabel.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/presenceLabel.ts packages/web/src/live/presenceLabel.test.ts
git commit -m "$(cat <<'EOF'
Add presence label helpers for office nameplates.

Short harness/model/work strings keep floating labels compact; full ids stay in titles.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 2: Pipe surface, model, and work into `OfficeNode`

**Files:**
- Modify: `packages/web/src/live/office-scene/types.ts`
- Modify: `packages/web/src/live/OfficeScene.tsx` (`computeData`)
- Modify: any `node()` test helpers that construct `OfficeNode` (e.g. `render.test.ts`)

**Interfaces:**
- Consumes: `RoomEntry` from `./workingOn`; `presenceLabel` unused yet
- Produces: extended `OfficeNode`:

```ts
surface: string | null;
model: string | null;
workTitle: string | null;
workSource: 'lane' | 'status' | null;
laneState: import('@musterd/protocol').LaneState | null;
moreLanes: number;
```

- [ ] **Step 1: Extend `OfficeNode` in `types.ts`**

Add the six fields above (defaults not needed — every constructor site sets them).

- [ ] **Step 2: Update `computeData` in `OfficeScene.tsx`**

```ts
function computeData(
  teamName: string,
  roster: MemberSummary[],
  entries: RoomEntry[],
): OfficeData {
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    teamName,
    nodes: roster.map((m) => {
      const kind = m.kind === 'human' ? 'human' : 'agent';
      const live =
        m.presences?.find((p) => p.status === 'online' || p.status === 'away') ??
        m.presences?.[0];
      const entry = byName.get(m.name);
      return {
        name: m.name,
        kind,
        presence: m.presence,
        activity: m.activity ?? (m.presence === 'offline' ? 'offline' : 'idle'),
        posture: memberPosture(m),
        state: m.state ?? null,
        color: memberColor(m.name, kind),
        role: m.role,
        surface: live?.surface ?? null,
        model: live?.model ?? null,
        workTitle: entry?.title ?? null,
        workSource: entry?.source ?? null,
        laneState: entry?.laneState ?? null,
        moreLanes: entry?.moreLanes ?? 0,
      };
    }),
  };
}
```

Wire `useMemo(() => computeData(teamName, roster, entries), [teamName, roster, entries])`.

- [ ] **Step 3: Fix test `node()` helpers**

In `render.test.ts` (and any other constructors), set the new fields to `null` / `0` so typecheck passes.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @musterd/web typecheck` (or root `pnpm typecheck`)

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/types.ts packages/web/src/live/OfficeScene.tsx packages/web/src/live/office-scene/render.test.ts
git commit -m "$(cat <<'EOF'
Carry surface, model, and work fields on office nodes.

Nameplates need harness/model/work from the same roster derivation the floor already uses.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 3: Identity lines on floating nameplates

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts` (`syncLabels`)
- Modify: `packages/web/src/live/Live.css` (`.lc-gl-label__meta`)

**Interfaces:**
- Consumes: `identityMeta` from `../presenceLabel`
- Produces: each present label shows name + optional meta line; `title` attr for full identity

- [ ] **Step 1: Update `syncLabels` to append meta**

Inside the existing `syncLabels` loop, after appending `nameEl`:

```ts
import { identityMeta, shortLaneState, truncateWork } from '../presenceLabel';

// after nameEl appended:
const meta = identityMeta({
  surface: node.surface,
  model: node.model,
  role: node.role,
});
if (meta.line && node.presence !== 'offline') {
  const metaEl = document.createElement('span');
  metaEl.className = 'lc-gl-label__meta';
  metaEl.textContent = meta.line;
  el.appendChild(metaEl);
  el.title = meta.title;
}
```

Do **not** add work lines yet (Task 4). Keep offline unlabeled as today (`presence !== 'online'` already dims; still skip meta if offline).

- [ ] **Step 2: CSS for meta**

```css
.lc-gl-label__meta {
  max-width: 9.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-paper) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--lc-paper-rim) 70%, transparent);
  font-family: var(--font-mono, monospace);
  font-size: 8px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--lc-dim);
  box-shadow: 0 1px 3px -1px var(--lc-paper-drop);
}
```

- [ ] **Step 3: Visual smoke**

Run local web preview (`pnpm --filter @musterd/web build` + preview, or existing `/office-preview` / `pnpm dev` on `:5174`). Confirm present members show a second line; offline stay name-only or unlabeled per existing rules.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/live/office-scene/index.ts packages/web/src/live/Live.css
git commit -m "$(cat <<'EOF'
Show harness · model · role on office floating nameplates.

Keeps identity on the person without a bottom roster rail.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 4: Hybrid work cue + hover tip

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts`
- Modify: `packages/web/src/live/Live.css`
- Modify: `packages/web/src/live/OfficeScene.tsx` — pass `interactiveLabels={!broadcast}` into mount options if needed

**Interfaces:**
- Consumes: `truncateWork`, `shortLaneState`
- Produces: work line under meta when `workTitle` set; CSS tip with full title + state on hover
- Kill switch: `const HYBRID_WORK_CUES = true` at top of `index.ts` (flip to `false` to hide always-on work lines without removing hover)

- [ ] **Step 1: Extend mount options**

In `mountOffice` options, add `interactiveLabels?: boolean` (true on `/live`, false on `/broadcast`). When true, set `labelHost.style.pointerEvents = 'none'` still on host, but each label `el.style.pointerEvents = 'auto'`.

- [ ] **Step 2: Append work line + tip in `syncLabels`**

```ts
const showWork =
  HYBRID_WORK_CUES &&
  node.presence !== 'offline' &&
  node.workTitle != null &&
  node.workTitle.length > 0;

if (showWork) {
  const workEl = document.createElement('span');
  workEl.className = 'lc-gl-label__work';
  const chip = shortLaneState(node.laneState);
  const said = node.workSource === 'status';
  workEl.textContent = [
    truncateWork(node.workTitle),
    chip,
    said ? 'said' : null,
    node.moreLanes > 0 ? `+${node.moreLanes}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  el.appendChild(workEl);
}

// Hover tip (identity + work) — only when interactive
if (interactiveLabels) {
  const tip = document.createElement('div');
  tip.className = 'lc-gl-label__tip';
  tip.setAttribute('role', 'tooltip');
  const lines = [
    meta.title || null,
    node.workTitle
      ? `${node.workTitle}${chip ? ` (${chip})` : ''}${said ? ' · said' : ''}`
      : null,
  ].filter(Boolean);
  tip.textContent = lines.join('\n');
  el.appendChild(tip);
}
```

(Use variables consistently; rebuild tip whenever meta/work exist.)

- [ ] **Step 3: CSS for work + tip**

```css
.lc-gl-label__work {
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-paper) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--lc-accent) 28%, var(--lc-paper-rim));
  font-family: var(--font-mono, monospace);
  font-size: 8px;
  font-weight: 500;
  color: var(--lc-paper-ink);
}

.lc-gl-label__tip {
  display: none;
  position: absolute;
  left: 50%;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  max-width: 16rem;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--lc-paper);
  border: 1px solid var(--lc-paper-rim);
  box-shadow: 0 4px 12px -2px var(--lc-paper-drop);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  white-space: pre-wrap;
  color: var(--lc-paper-ink);
  z-index: 3;
  pointer-events: none;
}
.lc-gl-label:hover .lc-gl-label__tip,
.lc-gl-label:focus-within .lc-gl-label__tip {
  display: block;
}
```

- [ ] **Step 4: Wire `interactiveLabels: !broadcast` from `OfficeScene`**

- [ ] **Step 5: Eye-check clutter**

With several working members, if the floor feels crowded, set `HYBRID_WORK_CUES = false` and proceed to Task 7 (WorkStack). Do not invent a settings UI.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/index.ts packages/web/src/live/Live.css packages/web/src/live/OfficeScene.tsx
git commit -m "$(cat <<'EOF'
Add hybrid work cues under office nameplates.

Truncated lane/status line plus hover tip; kill-switch ready for in-panel stack fallback.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 5: Wall whiteboard (orange marker on white)

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` — replace `wallRoster` + `BOARD` with `wallWhiteboard`
- Modify: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Consumes: existing `wallPt`, `quad`, `ellipse`, `fit`, wall edge helpers
- Produces: static whiteboard; **no** roster `nodes` input for content (signature can drop `nodes` or ignore it)

- [ ] **Step 1: Rewrite the wall painter**

Replace `wallRoster` with something shaped like:

```ts
const WHITEBOARD = {
  frame: DRESS.frame, // or a cooler aluminum if DRESS has one
  face: '#F7F7F5', // white / warm white
  ink: '#E1AD01', // mustard-500
  inkDim: 'rgba(225, 173, 1, 0.55)',
  shadow: 'rgba(58, 34, 12, 0.20)',
} as const;

/** Dry-erase board — set dressing only. Fake architecture scribbles in musterd orange. */
function wallWhiteboard(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
): void {
  const W = 92;
  const H = 80;
  const p = (a: number, b: number): Pt => wallPt(edge, tc + a / FLOOR, uc + b / WALL_H, fit);
  const rect = (a0: number, b0: number, a1: number, b1: number, fill: string): void =>
    quad(ctx, [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], fill);

  rect(-W / 2 + 3, -H / 2 - 3, W / 2 + 3, H / 2 - 3, WHITEBOARD.shadow);
  rect(-W / 2, -H / 2, W / 2, H / 2, WHITEBOARD.frame);
  rect(-W / 2 + 3, -H / 2 + 3.5, W / 2 - 3, H / 2 - 3.5, WHITEBOARD.face);

  // Marker strokes in board-local space (a along wall, b up). Keep strokes short — fitted scale ~0.52.
  const stroke = (pts: [number, number][], width: number, color: string) => {
    if (pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    const [a0, b0] = pts[0]!;
    const s0 = p(a0, b0);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = pts[i]!;
      const s = p(a, b);
      ctx.lineTo(s.x, s.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * fit.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };

  // Fake boxes + arrows (tune coordinates by eye on /office-preview)
  stroke([[-28, 18], [-28, -8], [-4, -8], [-4, 18], [-28, 18]], 1.4, WHITEBOARD.ink);
  stroke([[4, 12], [4, -14], [30, -14], [30, 12], [4, 12]], 1.4, WHITEBOARD.ink);
  stroke([[-4, 4], [4, 4]], 1.2, WHITEBOARD.ink); // connector
  stroke([[0, 4], [2, 6], [0, 8]], 1.2, WHITEBOARD.ink); // arrow head-ish
  stroke([[-22, -20], [-10, -28], [8, -26], [22, -18]], 1.1, WHITEBOARD.inkDim); // cloud-ish
  // Optional tiny wallText labels in ink — only if legible at scale; otherwise shapes alone
}
```

Call site: change `wallRoster(ctx, fit, edge, 0.885, 0.6, nodes)` → `wallWhiteboard(ctx, fit, edge, 0.885, 0.6)`.

Delete cork `BOARD` constant and member-color tag logic.

- [ ] **Step 2: Replace wall board tests**

Remove tests that assert member colors / `2/3` / 9-tag cap. Replace with:

```ts
describe('the wall whiteboard', () => {
  const fit = fitFloor(1200, 900);
  // reuse textCtx / paint-recording proxy from before

  it('paints the white face and mustard ink, not member roster colours', () => {
    const paints: string[] = [];
    const nodes = ['ada', 'bo'].map((n) => node(n, 'working'));
    renderScene(textCtx(paints, []), fit, new Map(), roster(nodes), new Map());
    expect(paints).toContain('#F7F7F5');
    expect(paints.some((c) => c === '#E1AD01' || c.includes('225, 173, 1'))).toBe(true);
    for (const n of nodes) expect(paints).not.toContain(n.color);
  });

  it('does not write a present/total count (no longer a roster)', () => {
    const texts: string[] = [];
    renderScene(textCtx([], texts), fit, new Map(), roster([node('ada', 'working')]), new Map());
    expect(texts.some((t) => /^\d+\/\d+$/.test(t))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm exec vitest run packages/web/src/live/office-scene/render.test.ts`

Expected: PASS

- [ ] **Step 4: Visual tune**

Open `/office-preview` or `/live` — board should read as a white dry-erase with orange diagram scribbles. Adjust stroke coordinates until it looks intentional, not noise.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/render.test.ts
git commit -m "$(cat <<'EOF'
Replace wall roster pinboard with orange-on-white dry-erase set dressing.

Wall object is atmosphere now; presence lives on the floor and nameplates.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 6: Remove bottom WHO’S IN + demote overlay on `/live`

**Files:**
- Delete: `packages/web/src/live/OfficeBoard.tsx`
- Modify: `packages/web/src/routes/live.tsx` — drop import + `bandSlot`
- Modify: `packages/web/src/live/OfficeScene.tsx` — do not render `OfficeOverlay` when `!broadcast`
- Modify: `packages/web/src/live/Live.css` — delete `.lc-office__band` / `.lc-notice*` block (or leave unused until Task 7 reuses band for WorkStack)
- Modify: `packages/web/src/routes/broadcast.tsx` — keep overlay as today

- [ ] **Step 1: Stop rendering `OfficeBoard` on `/live`**

Remove `bandSlot={<OfficeBoard …/>}` and the import. Delete `OfficeBoard.tsx`.

- [ ] **Step 2: Gate overlay**

In `OfficeScene.tsx`:

```tsx
{!broadcast ? null : (
  <OfficeOverlay
    teamName={teamName}
    present={presentCount(roster)}
    entries={entries}
    status={status}
    interactive={false}
  />
)}
```

(Or `broadcast && <OfficeOverlay … />`.) `/live` no longer shows the cycling card.

- [ ] **Step 3: CSS cleanup**

Remove `.lc-notice*` rules. Keep `.lc-office__band` if Task 7 will use it; otherwise remove band wrapper too.

- [ ] **Step 4: Grep for stragglers**

Run: `rg "OfficeBoard|lc-notice|WHO'S IN|wallRoster" packages/web`

Expected: no references to deleted board; `wallRoster` gone.

- [ ] **Step 5: Typecheck + web tests**

Run: `pnpm --filter @musterd/web typecheck && pnpm exec vitest run packages/web/src/live`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/src/live packages/web/src/routes/live.tsx packages/web/src/routes/broadcast.tsx
git commit -m "$(cat <<'EOF'
Remove WHO'S IN rail and live overlay reel from the office panel.

Identity and work cues live on nameplates; broadcast keeps a passive chyron.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 7: Fallback A — `WorkStack` (ready, not default)

**Files:**
- Create: `packages/web/src/live/WorkStack.tsx`
- Modify: `packages/web/src/routes/live.tsx` — optional band when hybrid off
- Modify: `packages/web/src/live/Live.css` — compact stack styles
- Modify: `packages/web/src/live/office-scene/index.ts` — export or share the `HYBRID_WORK_CUES` decision

**Interfaces:**
- Consumes: `RoomEntry[]`, `shortLaneState`, `truncateWork`
- Produces: present members with `title != null`, one row each

- [ ] **Step 1: Implement `WorkStack`**

```tsx
import type { RoomEntry } from './workingOn';
import { shortLaneState, truncateWork } from './presenceLabel';

/** Fallback A — in-panel list of present & working only (spec §2). */
export function WorkStack({ entries }: { entries: RoomEntry[] }) {
  const rows = entries.filter((e) => e.title != null);
  if (rows.length === 0) return null;
  return (
    <aside className="lc-workstack" aria-label="Who is working">
      <ul className="lc-workstack__list">
        {rows.map((e) => {
          const chip = shortLaneState(e.laneState);
          return (
            <li key={e.name} className="lc-workstack__row">
              <i className="lc-workstack__dot" style={{ background: e.color }} />
              <span className="lc-workstack__name">{e.name}</span>
              <span className="lc-workstack__title">{truncateWork(e.title!, 40)}</span>
              {chip && <span className="lc-workstack__state">{chip}</span>}
              {e.source === 'status' && <span className="lc-workstack__said">said</span>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 2: Single kill-switch**

In `routes/live.tsx` (or a tiny `officeChrome.ts`):

```ts
/** Spec fallback: when false, nameplates drop always-on work lines and WorkStack fills the band. */
export const HYBRID_WORK_CUES = true;
```

Import the same constant in `index.ts` (or pass `showWorkCues` through mount options from `OfficeScene` so there is **one** switch). Prefer passing a prop/option over cross-importing a route file into the canvas module.

Recommended: `OfficeScene` prop `workCues: 'hybrid' | 'stack' | 'none'` default `'hybrid'`.

- [ ] **Step 3: Wire band**

```tsx
bandSlot={workCues === 'stack' ? <WorkStack entries={entries} /> : undefined}
```

And pass `showWorkCues={workCues === 'hybrid'}` into `mountOffice`.

- [ ] **Step 4: Minimal CSS** for `.lc-workstack*` — mono, compact, paper tokens, max-height with scroll, **not** cork WHO’S IN styling.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/WorkStack.tsx packages/web/src/live/Live.css packages/web/src/routes/live.tsx packages/web/src/live/OfficeScene.tsx packages/web/src/live/office-scene/index.ts
git commit -m "$(cat <<'EOF'
Add in-panel WorkStack fallback for office work cues.

Ready when hybrid nameplate lines clutter the floor at dogfood density.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 8: Verify, docs touch-ups, handoff

**Files:**
- Possibly: `docs/architecture/*` only if an arch tree lists deleted/added files (web may not be drift-checked — check before editing)
- Spec already written; update status line at top of the plan checkboxes as you go

- [ ] **Step 1: Full web package checks**

Run:

```bash
pnpm --filter @musterd/web typecheck
pnpm exec vitest run packages/web/src/live
pnpm --filter @musterd/web build
pnpm perf:check
```

Expected: all green. If perf budget slips from label DOM only, measure and log per ADR 151 — do not raise casually.

- [ ] **Step 2: Dogfood visual**

`http://localhost:5174/live` (dev) or daemon `:4849/live?team=revive` after publish. Confirm:

1. No bottom WHO’S IN rail  
2. Nameplates show harness · model  
3. Working people show truncated work + state  
4. Hover shows full identity + work  
5. Wall is white + orange diagram, not colored chips  
6. Side ROSTER still has governance  

- [ ] **Step 3: Status + lane**

```text
team_send status_update — presence chrome implemented; hybrid vs stack call after eye test
```

If hybrid looks good, leave `workCues: 'hybrid'`. If not, flip to `'stack'` in the same PR.

- [ ] **Step 4: Open PR when ready** (ADR 106)

```bash
git fetch origin main
# ensure branch based on main
pnpm typecheck && pnpm format:check
git push -u origin HEAD
gh pr create --title "Office presence chrome: nameplates, hybrid work, whiteboard" --body "..."
gh pr merge <n> --squash --auto --delete-branch
```

- [ ] **Step 5: After merge — resolve lane with attestation; clear local branch**

---

## Spec coverage (self-review)

| Spec requirement | Task |
| --- | --- |
| Identity nameplate surface · model · role | 1, 2, 3 |
| Compact + hover full identity | 1, 3, 4 |
| Hybrid work cue + progress chip | 1, 4 |
| Fallback A WorkStack | 7 |
| Kill bottom WHO’S IN | 6 |
| Wall whiteboard white + `#E1AD01` ink | 5 |
| Demote overlay on `/live` | 6 |
| Broadcast keeps orientation | 6 |
| No protocol change | all |
| Perf contract | 8 |

**Placeholder scan:** none intentional.  
**Type consistency:** `OfficeNode` work fields match `RoomEntry`; `shortLaneState` shared by labels and WorkStack.
