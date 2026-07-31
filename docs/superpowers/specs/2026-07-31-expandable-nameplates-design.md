# Expandable office nameplates — compact identity + provider icon

**Date:** 2026-07-31  
**Approved by:** nick (in-session)  
**Owner:** miley  
**Surface:** `packages/web` (`/live` + `/broadcast` office panel)  
**Related:** [2026-07-30 office presence chrome](./2026-07-30-office-presence-chrome-design.md) §1 (supersedes the always-on harness · model text line)  
**Brand source:** AI training deck Model landscape slide — `~/lab/ai-training/sessions/the-meats/deck.html` + `assets/logos/*`

## Problem

Floating nameplates currently paint posture dot + name + harness + model in one paper pill. At team density that width competes with speech bubbles and the room; harness and role are useful on demand, not at every glance.

## Decision

Keep one paper pill per present member. **Collapsed** shows name + expand control + **provider brand icon**. **Expanded** (click) grows the pill to the right and reveals identity text. Auto-collapse after leave. Broadcast stays always-on compact (no toggle).

No protocol change. Work cues stay off the nameplate (WorkStack / hybrid cue unchanged).

---

## 1 · Layout & states

### Collapsed `/live`

```
● name ▸ [provider icon]
```

- Posture dot + member name always visible.
- Chevron (`▸` collapsed / `▾` expanded) is the expand affordance.
- Provider icon is the brand mark for the attested model family (see §3).

### Expanded `/live`

```
● name ▾ [provider icon] model · harness [· role]
```

- Grows **to the right**; name + chevron stay put.
- **Order:** icon → short model → harness → role (role only when non-empty).
- Icon **stays** while expanded (not replaced by text).
- Short labels: existing `plateModel` / `shortSurface` maps. Full raw ids remain available via hover tip / `title`.

### Broadcast

```
● name [provider icon] opus 5
```

- No chevron, no expand/collapse.
- Compact: icon + short model text only (no harness, no role).
- Tight type/padding so stream plates do not reclaim the width `/live` is shedding.

### Who gets a plate

Unchanged: present members with non-small poses. Offline / small actors stay unlabeled.

---

## 2 · Interaction & a11y

| Behavior | Rule |
| --- | --- |
| Expand | Click chevron **or** the plate (when interactive) |
| Collapse | Click again, or auto-close |
| Auto-close | After pointer **leaves** the plate, start a **5s** timer; on fire → collapse. Re-entering the plate **cancels** the timer. |
| Multiple open | Allowed; each plate has its own timer |
| Keyboard | Focused label: `Enter` / `Space` toggles. Focus chrome matches existing plate hover/focus |
| Interactive gate | Expand only when `interactiveLabels` is on (`/live`). Broadcast: `pointer-events: none`, no toggle |
| State across sync | `syncLabels` rebuilds DOM; keep `expanded` + timer handles in a **Map keyed by member name** outside the rebuild so presence ticks do not slam plates shut |
| Hover tip | Keep tip for full surface / raw model id (and work lines if present). Expanded plates may still show the tip for raw ids |

---

## 3 · Provider map

**Source of truth:** training deck Model landscape brand chips and logos. **Copy** SVGs into `packages/web` (do not runtime-load from `~/lab`).

| Provider id | Model id signals | Logo (from deck) | Border / fill / ink |
| --- | --- | --- | --- |
| `claude` | `claude`, opus / sonnet / haiku / fable | `claude.svg` | `#D97757` / `#FCEEE8` / `#5C2E1F` |
| `openai` | `gpt`, `o1` / `o3` / `o4` | `openai.svg` | `#10A37F` / `#E8F7F2` / `#0B5C47` |
| `gemini` | `gemini` | `googlegemini.svg` | `#8E75B2` / `#F0EBF8` / `#4A3A6E` |
| `xai` | `grok` | `x.svg` | `#333` / `#F2F2F2` / `#111` |
| `meta` | `llama` | `meta.svg` | `#0668E1` / `#E7F0FD` / `#044A9E` |
| `mistral` | `mistral` | `mistralai.svg` | `#F54E00` / `#FFF0E8` / `#8A2C00` |
| `qwen` | `qwen` | `qwen.svg` | `#FF6A00` / `#FFF1E6` / `#9A4000` |
| `deepseek` | `deepseek` | `deepseek.svg` | `#4D6BFE` / `#EBF0FF` / `#2A3FBF` |
| `kimi` | `kimi`, `moonshot` | `moonshotai.svg` | `#6366F1` / `#EEF0FF` / `#3730A3` |
| `minimax` | `minimax` | `minimax.svg` | `#E11D48` / `#FDE8EF` / `#9F1239` |
| `glm` | `glm`, `zai` | letter mark `G` (no logo on deck slide) | MiniMax / Z.ai colors above |
| `nova` | `nova` | `amazonwebservices.svg` | `#FF9900` / `#FFF4E5` / `#9A5C00` |
| `unknown` | else / missing / `unknown` | neutral glyph | paper-ink muted |

**Plate treatment:** ~10–12px inline SVG using the logo’s brand fill. Optional tiny tinted chip (deck fill + border) behind the mark for glanceability — keep it small so the collapsed pill stays narrow.

**API (UI-only):** e.g. `modelProvider(model) → { id, border, fill, ink }` plus an icon renderer. Lives next to `presenceLabel.ts` (or a sibling `modelProvider.ts`). Exhaustive switch / never-default for known ids.

---

## 4 · Data & files

**Data:** existing `node.surface`, `node.model`, `node.role` only. No SPEC / protocol change.

**Likely touch:**

| File | Change |
| --- | --- |
| `packages/web/src/live/office-scene/index.ts` | Plate DOM: chevron, icon, expand segments, expand Map + 5s timers |
| `packages/web/src/live/Live.css` | Collapsed / expanded plate, icon, chevron, broadcast compact crumb |
| `packages/web/src/live/presenceLabel.ts` (+ tests) | Provider resolve; optional detail-segment helper |
| `packages/web/src/live/modelProvider*.ts` (or assets) | Copied SVGs + icon helper — **no new npm dependency** |
| `packages/web/src/routes/office-preview.tsx` | Fixture variety so icons + expand can be eyeballed |

**Tests:** provider mapping unit tests; presenceLabel detail order; optional DOM/behavior tests if the scene already has a harness for label sync.

---

## 5 · Out of scope

- Role system itself (render only when non-empty)
- Desk plaques / canvas-painted nameplates
- Harness brand icons (harness stays text)
- Work titles back on the plate
- Protocol / attestation changes
- SaaS tool brands from the deck that are not model providers (Slack, Figma, etc.)

---

## Success

- At a glance on `/live`, plates read as **name + brand mark** and take less width than today’s harness · model line.
- One click reveals **icon · model · harness · role** without a second chrome shape.
- Leaving a plate collapses it within ~5s unless the pointer returns.
- `/broadcast` stays compact and non-interactive: icon + short model.
- Provider colors/logos match the training deck Model landscape tokens.
