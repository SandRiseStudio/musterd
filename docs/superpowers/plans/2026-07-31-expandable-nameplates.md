# Expandable Nameplates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink office nameplates to name + provider brand icon by default; click-expand reveals model · harness · role (icon stays), with a 5s leave auto-close on `/live` and a compact icon + short-model crumb on `/broadcast`.

**Architecture:** Pure helpers (`modelProvider`, plate detail segments, SVG markup strings) unit-tested under vitest/node. `mountOffice` / `syncLabels` owns DOM: chevron, icon chip, expand Map + per-member 5s timers outside the rebuild. CSS only for collapsed/expanded chrome. Logos and chip colors copied from the AI training deck Model landscape slide — no new npm deps, no protocol change.

**Tech Stack:** TypeScript, vitest (node), plain CSS in `Live.css`, imperative DOM in `office-scene/index.ts`. No React changes required except `office-preview` mount options / fixtures.

**Spec:** [docs/superpowers/specs/2026-07-31-expandable-nameplates-design.md](../specs/2026-07-31-expandable-nameplates-design.md)

**Branch:** `feat/expandable-nameplates`

## Global Constraints

- **No new runtime dependencies** without an ADR (`packages/web/AGENTS.md`).
- **Fonts:** Inter, Space Grotesk, Space Mono only.
- **`pnpm perf:check` must pass.** Inline SVGs are tiny; do not import icon packs.
- **No new rAF/interval for labels** beyond existing scene loop. Expand uses `setTimeout` only; clear on dispose / collapse.
- **Tests are `.test.ts`, environment `node`.** Pure functions only — no jsdom. Eye-test expand on `/office-preview` and `/live`.
- **No protocol / schema changes.**
- **Provider brand tokens** must match the training deck (`~/lab/ai-training/sessions/the-meats/deck.html` `.b-*` chips + `assets/logos/*`).
- Run `pnpm exec prettier --write <files>` — never `pnpm format`.
- Vitest from **repo root**. Fast gates before push: `pnpm typecheck && pnpm format:check`.
- Seat trailer: `Co-authored-by: miley <miley@revive.musterd>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/web/src/live/modelProvider.ts` (create) | Resolve model id → provider id + chip colors |
| `packages/web/src/live/modelProvider.test.ts` (create) | Provider mapping tests |
| `packages/web/src/live/modelProviderIcon.ts` (create) | Inline SVG / letter-mark HTML for a provider |
| `packages/web/src/live/provider-logos/*.svg` (create) | Copied deck logos (provenance; markup inlined into `modelProviderIcon.ts`) |
| `packages/web/src/live/provider-logos/README.md` (create) | Points at lab deck as brand source |
| `packages/web/src/live/presenceLabel.ts` (modify) | `plateDetailSegments` — expand text order |
| `packages/web/src/live/presenceLabel.test.ts` (modify) | Detail segment order tests |
| `packages/web/src/live/Live.css` (modify) | Chevron, icon chip, expanded segments, broadcast compact |
| `packages/web/src/live/office-scene/index.ts` (modify) | `syncLabels` rebuild + expand Map/timers/handlers |
| `packages/web/src/routes/office-preview.tsx` (modify) | `interactiveLabels: true`; wider fixture providers |

---

### Task 1: `modelProvider` resolve

**Files:**
- Create: `packages/web/src/live/modelProvider.ts`
- Test: `packages/web/src/live/modelProvider.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  ```ts
  export type ModelProviderId =
    | 'claude' | 'openai' | 'gemini' | 'xai' | 'meta' | 'mistral'
    | 'qwen' | 'deepseek' | 'kimi' | 'minimax' | 'glm' | 'nova' | 'unknown';

  export type ModelProvider = {
    id: ModelProviderId;
    border: string;
    fill: string;
    ink: string;
  };

  export function modelProvider(model: string | null | undefined): ModelProvider;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { modelProvider } from './modelProvider';

describe('modelProvider', () => {
  it('maps Claude families (including fable) to claude chip colors', () => {
    for (const id of ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      const p = modelProvider(id);
      expect(p.id).toBe('claude');
      expect(p.border).toBe('#D97757');
      expect(p.fill).toBe('#FCEEE8');
      expect(p.ink).toBe('#5C2E1F');
    }
  });

  it('maps gpt / o-series to openai', () => {
    expect(modelProvider('gpt-5.6-terra-medium').id).toBe('openai');
    expect(modelProvider('o3-pro').id).toBe('openai');
    expect(modelProvider('gpt-5.6-luna-medium').border).toBe('#10A37F');
  });

  it('maps gemini, grok, llama, mistral, qwen, deepseek, kimi, minimax, glm, nova', () => {
    expect(modelProvider('gemini-3.2-pro').id).toBe('gemini');
    expect(modelProvider('grok-4.5').id).toBe('xai');
    expect(modelProvider('llama-4-maverick').id).toBe('meta');
    expect(modelProvider('mistral-large-3').id).toBe('mistral');
    expect(modelProvider('qwen-3.5').id).toBe('qwen');
    expect(modelProvider('deepseek-v4-pro').id).toBe('deepseek');
    expect(modelProvider('kimi-k3').id).toBe('kimi');
    expect(modelProvider('moonshot-v1').id).toBe('kimi');
    expect(modelProvider('minimax-m3').id).toBe('minimax');
    expect(modelProvider('glm-5.2').id).toBe('glm');
    expect(modelProvider('zai-glm').id).toBe('glm');
    expect(modelProvider('amazon-nova-2-pro').id).toBe('nova');
  });

  it('returns unknown for missing / unknown / empty', () => {
    expect(modelProvider(null).id).toBe('unknown');
    expect(modelProvider('unknown').id).toBe('unknown');
    expect(modelProvider('').id).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/web/src/live/modelProvider.test.ts`

Expected: FAIL — cannot find module `./modelProvider`

- [ ] **Step 3: Write minimal implementation**

Create `packages/web/src/live/modelProvider.ts`:

```ts
export type ModelProviderId =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'minimax'
  | 'glm'
  | 'nova'
  | 'unknown';

export type ModelProvider = {
  id: ModelProviderId;
  border: string;
  fill: string;
  ink: string;
};

/** Chip tokens from lab AI training deck Model landscape (`.b-*`). */
const CHIPS: Record<ModelProviderId, Omit<ModelProvider, 'id'>> = {
  claude: { border: '#D97757', fill: '#FCEEE8', ink: '#5C2E1F' },
  openai: { border: '#10A37F', fill: '#E8F7F2', ink: '#0B5C47' },
  gemini: { border: '#8E75B2', fill: '#F0EBF8', ink: '#4A3A6E' },
  xai: { border: '#333', fill: '#F2F2F2', ink: '#111' },
  meta: { border: '#0668E1', fill: '#E7F0FD', ink: '#044A9E' },
  mistral: { border: '#F54E00', fill: '#FFF0E8', ink: '#8A2C00' },
  qwen: { border: '#FF6A00', fill: '#FFF1E6', ink: '#9A4000' },
  deepseek: { border: '#4D6BFE', fill: '#EBF0FF', ink: '#2A3FBF' },
  kimi: { border: '#6366F1', fill: '#EEF0FF', ink: '#3730A3' },
  minimax: { border: '#E11D48', fill: '#FDE8EF', ink: '#9F1239' },
  glm: { border: '#E11D48', fill: '#FDE8EF', ink: '#9F1239' },
  nova: { border: '#FF9900', fill: '#FFF4E5', ink: '#9A5C00' },
  unknown: { border: 'transparent', fill: 'transparent', ink: 'currentColor' },
};

function chip(id: ModelProviderId): ModelProvider {
  return { id, ...CHIPS[id] };
}

/**
 * Map an attested model id to a provider chip. Order matters: match specific families before
 * broad vendor prefixes. Exhaustive via Record — adding a provider requires a CHIPS entry.
 */
export function modelProvider(model: string | null | undefined): ModelProvider {
  if (!model) return chip('unknown');
  const lower = model.trim().toLowerCase();
  if (!lower || lower === 'unknown') return chip('unknown');

  if (/\b(opus|sonnet|haiku|fable)\b/.test(lower) || lower.includes('claude')) return chip('claude');
  if (/\bgpt\b/.test(lower) || /\bo[1-9]\b/.test(lower)) return chip('openai');
  if (lower.includes('gemini')) return chip('gemini');
  if (lower.includes('grok')) return chip('xai');
  if (lower.includes('llama')) return chip('meta');
  if (lower.includes('mistral')) return chip('mistral');
  if (lower.includes('qwen')) return chip('qwen');
  if (lower.includes('deepseek')) return chip('deepseek');
  if (lower.includes('kimi') || lower.includes('moonshot')) return chip('kimi');
  if (lower.includes('minimax')) return chip('minimax');
  if (/\bglm\b/.test(lower) || lower.includes('zai')) return chip('glm');
  if (lower.includes('nova')) return chip('nova');
  return chip('unknown');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/web/src/live/modelProvider.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/modelProvider.ts packages/web/src/live/modelProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(web): resolve model id to provider brand chips

Map attested model strings to training-deck chip colors for nameplate icons.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 2: Provider logo assets + icon HTML

**Files:**
- Create: `packages/web/src/live/provider-logos/` — copy these from `~/lab/ai-training/sessions/the-meats/assets/logos/`:
  - `claude.svg`, `openai.svg`, `googlegemini.svg`, `x.svg`, `meta.svg`, `mistralai.svg`, `qwen.svg`, `deepseek.svg`, `moonshotai.svg`, `minimax.svg`, `amazonwebservices.svg`
- Create: `packages/web/src/live/provider-logos/README.md`
- Create: `packages/web/src/live/modelProviderIcon.ts`
- Test: extend `packages/web/src/live/modelProvider.test.ts` (or `modelProviderIcon.test.ts`)

**Interfaces:**
- Consumes: `ModelProvider` / `ModelProviderId` from `modelProvider.ts`
- Produces:
  ```ts
  /** Returns inner HTML for a ~12px provider mark (svg or letter). */
  export function providerIconHtml(provider: ModelProvider): string;
  ```

- [ ] **Step 1: Copy logos + README**

```bash
mkdir -p packages/web/src/live/provider-logos
cp ~/lab/ai-training/sessions/the-meats/assets/logos/{claude,openai,googlegemini,x,meta,mistralai,qwen,deepseek,moonshotai,minimax,amazonwebservices}.svg \
  packages/web/src/live/provider-logos/
```

`README.md`:

```md
# Provider logos

Copied from the SandRise AI training deck Model landscape slide
(`~/lab/ai-training/sessions/the-meats/assets/logos/`). Brand chip colors live in
`modelProvider.ts`. Runtime markup is inlined in `modelProviderIcon.ts` so vitest/node
does not need Vite `?raw` — when a logo changes upstream, update both the file here and
the inline string.
```

- [ ] **Step 2: Write the failing icon test**

```ts
import { providerIconHtml } from './modelProviderIcon';
import { modelProvider } from './modelProvider';

describe('providerIconHtml', () => {
  it('returns an svg for claude and openai', () => {
    const claude = providerIconHtml(modelProvider('claude-opus-5'));
    expect(claude).toContain('<svg');
    expect(claude).toContain('#D97757');

    const openai = providerIconHtml(modelProvider('gpt-5.6'));
    expect(openai).toContain('<svg');
    expect(openai).toContain('#10A37F');
  });

  it('returns a letter mark for glm (no deck logo)', () => {
    const html = providerIconHtml(modelProvider('glm-5.2'));
    expect(html).toContain('G');
    expect(html).not.toMatch(/<svg[\s\S]*path/i);
  });

  it('returns a neutral mark for unknown', () => {
    const html = providerIconHtml(modelProvider(null));
    expect(html.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run packages/web/src/live/modelProvider.test.ts`

Expected: FAIL — cannot find `./modelProviderIcon`

- [ ] **Step 4: Implement `modelProviderIcon.ts`**

Read each copied SVG; paste its full markup into a `const` map keyed by `ModelProviderId`. For `glm`, return a small HTML letter:

```ts
`<span class="lc-gl-label__provider-letter" style="color:${provider.ink}">G</span>`
```

For `unknown`:

```ts
`<span class="lc-gl-label__provider-letter" aria-hidden="true">?</span>`
```

`providerIconHtml`:

```ts
export function providerIconHtml(provider: ModelProvider): string {
  switch (provider.id) {
    case 'claude':
      return CLAUDE_SVG;
    case 'openai':
      return OPENAI_SVG;
    case 'gemini':
      return GEMINI_SVG;
    case 'xai':
      return XAI_SVG;
    case 'meta':
      return META_SVG;
    case 'mistral':
      return MISTRAL_SVG;
    case 'qwen':
      return QWEN_SVG;
    case 'deepseek':
      return DEEPSEEK_SVG;
    case 'kimi':
      return KIMI_SVG;
    case 'minimax':
      return MINIMAX_SVG;
    case 'nova':
      return NOVA_SVG;
    case 'glm':
      return `<span class="lc-gl-label__provider-letter" style="color:${provider.ink}">G</span>`;
    case 'unknown':
      return `<span class="lc-gl-label__provider-letter" aria-hidden="true">?</span>`;
    default: {
      const _exhaustive: never = provider.id;
      return _exhaustive;
    }
  }
}
```

Ensure each SVG string keeps the brand `fill` from the deck file. Add `aria-hidden="true"` on the root `<svg>` (decorative; name is adjacent).

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm exec vitest run packages/web/src/live/modelProvider.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/provider-logos packages/web/src/live/modelProviderIcon.ts packages/web/src/live/modelProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(web): inline provider logos for nameplate icons

Copy training-deck SVGs and expose providerIconHtml for the office plate.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 3: Expand detail segments helper

**Files:**
- Modify: `packages/web/src/live/presenceLabel.ts`
- Modify: `packages/web/src/live/presenceLabel.test.ts`

**Interfaces:**
- Consumes: `shortSurface`, `plateModel` (existing)
- Produces:
  ```ts
  /** Text segments for the expanded plate, in display order: model → harness → role. */
  export function plateDetailSegments(opts: {
    surface?: string | null;
    model?: string | null;
    role?: string | null;
  }): string[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { plateDetailSegments } from './presenceLabel';

describe('plateDetailSegments', () => {
  it('orders model then harness then role', () => {
    expect(
      plateDetailSegments({
        surface: 'cursor',
        model: 'claude-opus-5',
        role: 'backend',
      }),
    ).toEqual(['opus 5', 'cursor', 'backend']);
  });

  it('omits empty parts', () => {
    expect(plateDetailSegments({ surface: 'cli', model: null, role: '' })).toEqual(['cli']);
    expect(plateDetailSegments({ surface: null, model: 'grok-4.5' })).toEqual(['grok 4.5']);
    expect(plateDetailSegments({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`plateDetailSegments` not exported)

Run: `pnpm exec vitest run packages/web/src/live/presenceLabel.test.ts`

- [ ] **Step 3: Implement**

In `presenceLabel.ts`:

```ts
export function plateDetailSegments(opts: {
  surface?: string | null;
  model?: string | null;
  role?: string | null;
}): string[] {
  const parts: string[] = [];
  const mod = plateModel(opts.model);
  if (mod) parts.push(mod);
  const surf = shortSurface(opts.surface);
  if (surf) parts.push(surf);
  const role = opts.role?.trim() ?? '';
  if (role) parts.push(role);
  return parts;
}
```

Update the `plateModel` / `identityMeta` comments: harness is no longer always-on; expand + tip carry it. Leave `identityMeta` behavior intact for tip titles (surface · model · role is fine for hover).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/presenceLabel.ts packages/web/src/live/presenceLabel.test.ts
git commit -m "$(cat <<'EOF'
feat(web): plateDetailSegments for expand order

Expanded nameplate text is model · harness · role.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 4: Nameplate CSS (collapsed / expanded / broadcast)

**Files:**
- Modify: `packages/web/src/live/Live.css` (nameplate block ~998–1130)

**Interfaces:**
- Consumes: class names from Task 5 (`lc-gl-label__toggle`, `__provider`, `__detail`, `__seg`, `is-expanded`)
- Produces: styles those classes

- [ ] **Step 1: Replace / extend the nameplate CSS**

Keep `.lc-gl-label__plate` as the paper pill. Add:

```css
.lc-gl-label__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 3px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--lc-paper-ink) 55%, transparent);
  font: inherit;
  font-size: 7px;
  line-height: 1;
  cursor: pointer;
}
.lc-gl-label__provider {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 5px;
  border-radius: 4px;
  border: 1px solid transparent;
  flex: none;
  overflow: hidden;
}
.lc-gl-label__provider svg {
  width: 10px;
  height: 10px;
  display: block;
}
.lc-gl-label__provider-letter {
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
}
.lc-gl-label__detail {
  display: none;
  align-items: center;
  max-width: 11rem;
}
.lc-gl-label.is-expanded .lc-gl-label__detail {
  display: inline-flex;
}
.lc-gl-label__seg {
  max-width: 4.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: lowercase;
  color: color-mix(in srgb, var(--lc-paper-ink) 78%, transparent);
}
/* Broadcast: always show compact model crumb after the icon; never a toggle */
.lc-gl-label.is-broadcast .lc-gl-label__toggle {
  display: none;
}
.lc-gl-label.is-broadcast .lc-gl-label__detail {
  display: inline-flex;
}
.lc-gl-label.is-broadcast .lc-gl-label__seg--harness,
.lc-gl-label.is-broadcast .lc-gl-label__seg--role {
  display: none;
}
```

Reuse existing `.lc-gl-label__rule` between detail segments. Tighten `.lc-gl-label__plate` `max-width` if needed (collapsed should stay under ~9rem).

Remove reliance on always painting two `__model` text segments for harness+model (Task 5 stops creating them when collapsed).

- [ ] **Step 2: Prettier**

Run: `pnpm exec prettier --write packages/web/src/live/Live.css`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/live/Live.css
git commit -m "$(cat <<'EOF'
style(web): collapsed nameplate icon + expand detail chrome

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 5: `syncLabels` expand DOM + 5s leave timer

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts` (`syncLabels` ~344–441, `dispose`, imports)

**Interfaces:**
- Consumes: `modelProvider`, `providerIconHtml`, `plateDetailSegments`, `plateModel`, `shortSurface`, `identityMeta`
- Produces: working expand/collapse on interactive labels; broadcast compact crumb

- [ ] **Step 1: Add expand state outside `syncLabels`**

Near `const labels = new Map...`:

```ts
const AUTO_COLLAPSE_MS = 5000;
/** Expand + timer state survives syncLabels DOM rebuilds. */
const plateExpand = new Map<
  string,
  { expanded: boolean; timer: ReturnType<typeof setTimeout> | null }
>();

function clearExpandTimer(name: string) {
  const st = plateExpand.get(name);
  if (!st?.timer) return;
  clearTimeout(st.timer);
  st.timer = null;
}

function scheduleCollapse(name: string) {
  const st = plateExpand.get(name);
  if (!st?.expanded) return;
  clearExpandTimer(name);
  st.timer = setTimeout(() => {
    st.expanded = false;
    st.timer = null;
    const el = labels.get(name);
    el?.classList.remove('is-expanded');
    const btn = el?.querySelector('.lc-gl-label__toggle');
    if (btn) {
      btn.textContent = '▸';
      btn.setAttribute('aria-expanded', 'false');
    }
  }, AUTO_COLLAPSE_MS);
}

function toggleExpand(name: string) {
  if (!interactiveLabels) return;
  let st = plateExpand.get(name);
  if (!st) {
    st = { expanded: false, timer: null };
    plateExpand.set(name, st);
  }
  clearExpandTimer(name);
  st.expanded = !st.expanded;
  const el = labels.get(name);
  if (!el) return;
  el.classList.toggle('is-expanded', st.expanded);
  const btn = el.querySelector('.lc-gl-label__toggle');
  if (btn) {
    btn.textContent = st.expanded ? '▾' : '▸';
    btn.setAttribute('aria-expanded', st.expanded ? 'true' : 'false');
  }
}
```

On `dispose()`, clear all timers in `plateExpand` and empty the map.

When removing a label in the `seen` sweep, `clearExpandTimer(name)` and `plateExpand.delete(name)`.

- [ ] **Step 2: Rebuild plate DOM in `syncLabels`**

Replace the harness|model segment loop with:

**Always (present):**
1. dot + who (name)
2. If `interactiveLabels`: toggle button `▸`/`▾` (`type` not applicable on span — use `<button type="button" class="lc-gl-label__toggle">`, stopPropagation on click)
3. Provider chip: `<span class="lc-gl-label__provider">` with `style.borderColor = provider.border`, `style.background = provider.fill`, `innerHTML = providerIconHtml(provider)`
4. Detail host `.lc-gl-label__detail`:
   - `/live` interactive: all `plateDetailSegments` each behind a `__rule`, class `__seg` (+ `__seg--harness` / `__seg--role` by index/kind)
   - broadcast (`!interactiveLabels`): only the model segment via `plateModel` (one seg, class `__seg--model`) so CSS `is-broadcast` can show it always

Set `el.classList.toggle('is-broadcast', !interactiveLabels)`.
Restore expand class from `plateExpand.get(name)?.expanded`.

**Events (only if `interactiveLabels`):**
- `plate.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(name); })`
- toggle button click: same (stopPropagation so it doesn’t double-toggle if both fire — **either** bind toggle only on button **or** only on plate; prefer **plate click + keyboard on el**, and make the button `aria` only that calls `toggleExpand` with `stopPropagation` so one path wins: **button click stops propagation and toggles; plate click toggles; do not bind both without stopPropagation**)
- `el.addEventListener('pointerenter', () => clearExpandTimer(name))`
- `el.addEventListener('pointerleave', () => scheduleCollapse(name))`
- `el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(name); } })`

**Important:** `syncLabels` currently does `el.textContent = ''` which destroys nodes and would drop listeners if re-bound every sync. Either:
- **(A)** rebuild DOM every sync but re-attach listeners each time (simple; OK at roster size), or
- **(B)** only update text when structure unchanged.

Use **(A)** — re-bind each sync; timers live in `plateExpand`, not on the element.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @musterd/web typecheck`

Expected: PASS

- [ ] **Step 4: Unit tests still green**

Run: `pnpm exec vitest run packages/web/src/live/modelProvider.test.ts packages/web/src/live/presenceLabel.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/index.ts
git commit -m "$(cat <<'EOF'
feat(web): expandable nameplates with provider icons

Collapsed plate shows name + brand icon; expand reveals model · harness · role
with a 5s leave auto-close. Broadcast stays icon + short model.

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 6: Office preview fixtures + interactive labels

**Files:**
- Modify: `packages/web/src/routes/office-preview.tsx`

**Interfaces:**
- Consumes: `mountOffice(..., { interactiveLabels: true })`
- Produces: eyeball surface for every major provider

- [ ] **Step 1: Enable interactive labels on preview**

Change mount from:

```ts
const handle = mountOffice(host, labelHost, false);
```

to:

```ts
const handle = mountOffice(host, labelHost, false, { interactiveLabels: true });
```

- [ ] **Step 2: Diversify `FIXTURE_IDENTITY` models** so icons exercise the map

```ts
const FIXTURE_IDENTITY: Record<string, { surface: string; model: string | null; role?: string }> = {
  Ada: { surface: 'claude-code', model: 'claude-opus-5', role: 'lead' },
  Bo: { surface: 'cursor', model: 'claude-sonnet-4-5' },
  Cy: { surface: 'codex', model: 'gpt-5.6-terra-medium' },
  Dev: { surface: 'cli', model: null },
  Eli: { surface: 'claude-code', model: 'gemini-3.2-pro' },
  Fen: { surface: 'web', model: 'grok-4.5' },
  Gus: { surface: 'slack', model: 'llama-4-maverick' },
  Hana: { surface: 'claude-code', model: 'deepseek-v4-pro' },
  Ivy: { surface: 'cursor', model: 'mistral-large-3', role: 'design' },
};
```

Thread `role` into the node build (`role: FIXTURE_IDENTITY[m.name]?.role ?? ''`).

- [ ] **Step 3: Manual check**

Run: `pnpm --filter @musterd/web dev` → open `http://localhost:5174/office-preview`

Verify:
- Collapsed: name + chevron + colored icon
- Click expands to the right with model · harness · role
- Leave plate → collapses ~5s later; re-enter cancels
- Dev (null model) shows unknown/neutral mark

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/office-preview.tsx
git commit -m "$(cat <<'EOF'
chore(web): exercise expandable nameplates on office-preview

Co-authored-by: miley <miley@revive.musterd>
EOF
)"
```

---

### Task 7: Fast gates + claim check

**Files:** none required unless typecheck/format fails

- [ ] **Step 1: Run gates**

```bash
pnpm typecheck && pnpm format:check
pnpm exec vitest run packages/web/src/live/modelProvider.test.ts packages/web/src/live/presenceLabel.test.ts
```

Expected: all PASS

- [ ] **Step 2: Optional perf sanity** — if web build chunk jumped oddly, run `pnpm perf:check` after `pnpm --filter @musterd/web build`. Inline SVGs should be negligible.

- [ ] **Step 3: Status update on the team** when shipping / opening PR (implementer).

---

## Spec coverage (self-review)

| Spec requirement | Task |
| --- | --- |
| Collapsed: name + chevron + provider icon | 4, 5 |
| Expanded order: icon · model · harness · role | 3, 5 |
| Icon stays when expanded | 5 |
| 5s auto-close after leave; cancel on re-enter | 5 |
| Multiple plates independently open | 5 (`plateExpand` Map) |
| Keyboard Enter/Space | 5 |
| interactiveLabels gate; broadcast non-interactive | 5 |
| Broadcast: icon + short model only | 4 (`is-broadcast`), 5 |
| Expand state survives syncLabels rebuild | 5 (`plateExpand`) |
| Full provider map + deck colors/logos | 1, 2 |
| GLM letter mark | 2 |
| No protocol change / no new deps | Global + all tasks |
| office-preview eyeball | 6 |

**Placeholder scan:** none intentional.  
**Type consistency:** `ModelProvider` / `ModelProviderId` / `providerIconHtml` / `plateDetailSegments` names match across tasks.
