import RiveCanvas from '@rive-app/canvas-advanced';
import riveWasmUrl from '@rive-app/canvas-advanced/rive.wasm?url';
import { officeToRig, spriteKey } from './rig';
import type { OfficeNode, Pose } from './types';

/**
 * Runtime bridge to `character.riv` (authored via the Rive Editor MCP — see office-rive-character-spec).
 * Each member gets its own artboard + state-machine + view-model instance; every frame the office sets
 * the instance values from `officeToRig(node, pose)`, advances, and draws the character to a shared
 * offscreen which the depth-sorted `renderScene` blits at the member's projected feet. Async + WASM, so
 * it loads client-only and degrades to the code-drawn avatar (`drawActor`) if anything fails.
 *
 * Artboard is 180×260 with the character's feet at (90, 235) — see `FEET_*` below.
 *
 * Note on the WASM console line "No WebGL support. Image mesh will not be drawn.": it appears only when
 * the browser has no WebGL and refers to Rive *image meshes* — which `character.riv` does not use (it is
 * flat vector shapes). Verified identical rendering with WebGL on vs off, so it is benign; the offscreen
 * 2D canvas renderer draws the whole character regardless. Nothing to gate on it.
 */

const ARTBOARD_W = 180;
const ARTBOARD_H = 260;
const FEET_X = 90 / ARTBOARD_W; // 0.5
const FEET_Y = 235 / ARTBOARD_H;
const SS = 2; // supersample the offscreen for crisp downscaled blits
/** After an input change (e.g. a member settling from a gesture back to idle), keep advancing + rendering
 * this many frames so the Rive state-machine transition plays out, *then* freeze into the sprite-cache.
 * Long enough to cover the idle-transition (preserving the afterglow ease, ADR 086 #5), short enough that a
 * settled seat still stops costing a Rive advance. Sized in frames, so it's a touch longer under the 20fps
 * ambient cap — harmless. */
const SETTLE_FRAMES = 30;

/** `#aarrggbb` → uint32 ARGB (Rive colour value). */
function argbUint(hex: string): number {
  return parseInt(hex.slice(1), 16) >>> 0;
}

interface Member {
  artboard: { advance(s: number): boolean; draw(r: unknown): void; bindViewModelInstance(v: unknown): void };
  sm: { advance(s: number): boolean };
  vmi: {
    number(p: string): { value: number } | null | undefined;
    color(p: string): { value: number } | null | undefined;
  };
  // ── Idle sprite-cache (ADR 086 Phase 3) ──────────────────────────────────────────────────────────
  /** Last rendered appearance signature (from `spriteKey`); a change (or a move) marks the member dirty. */
  key: string;
  /** This member needs a live Rive advance + re-render this frame; set in `advance`, cleared in `draw`. */
  dirty: boolean;
  /** True while the member's pose is moving — never cached (its animation phase changes every frame) and
   * blitted sub-pixel for smooth travel; a still member is integer-aligned to avoid subpixel blur. */
  moving: boolean;
  /** Frames left to keep re-rendering after the last input change so a state transition settles on-screen
   * before the frame freezes into the cache. */
  settle: number;
  /** The member's last rendered frame, held so an unchanged idle seat blits a bitmap instead of re-running
   * Rive. Null until the first render; dropped with the member when they leave. */
  cache: HTMLCanvasElement | null;
  cctx: CanvasRenderingContext2D | null;
}

/** Set a VM colour only if the asset exposes it — so a property added to a newer `.riv` (e.g. `hairColor`)
 * lights up automatically, while an older asset that lacks it is a silent no-op instead of a crash. */
function setColorIfPresent(vmi: Member['vmi'], prop: string, argb: number): void {
  try {
    const c = vmi.color(prop);
    if (c) c.value = argb;
  } catch {
    /* property absent on this asset — ignore */
  }
}

/** Number counterpart of {@link setColorIfPresent} — for optional inputs a newer `.riv` may add (e.g.
 * `hairStyle`). No-op (and never throws) when the asset lacks the input. */
function setNumberIfPresent(vmi: Member['vmi'], prop: string, value: number): void {
  try {
    const n = vmi.number(prop);
    if (n) n.value = value;
  } catch {
    /* input absent on this asset — ignore */
  }
}

export interface RiveRig {
  /** Set VM values + advance every present member (call once per frame). */
  advance(dt: number, present: Map<string, { node: OfficeNode; pose: Pose }>): void;
  has(name: string): boolean;
  /** Blit a member's current frame so its feet land at (feetX, feetY); `spriteH` = on-screen height px. */
  draw(ctx: CanvasRenderingContext2D, name: string, feetX: number, feetY: number, spriteH: number): void;
  dispose(): void;
}

export async function loadRiveRig(): Promise<RiveRig | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rive: any = await RiveCanvas({ locateFile: () => riveWasmUrl });
    const bytes = new Uint8Array(await (await fetch('/office/character.riv')).arrayBuffer());
    const file = await rive.load(bytes);

    const offscreen = document.createElement('canvas');
    offscreen.width = ARTBOARD_W * SS;
    offscreen.height = ARTBOARD_H * SS;
    const renderer = rive.makeRenderer(offscreen);

    const members = new Map<string, Member>();

    function ensure(name: string): Member {
      let m = members.get(name);
      if (!m) {
        const artboard = file.artboardByName('Character');
        const sm = new rive.StateMachineInstance(artboard.stateMachineByName('State'), artboard);
        const vm = file.viewModelByName('Character');
        const vmi = vm.instanceByName('Instance') ?? vm.defaultInstance();
        artboard.bindViewModelInstance(vmi);
        // Bind the *state machine* to the same instance too — its transitions are viewModel comparisons
        // (mode/gesture), and without this the SM can't read those properties, so only the unconditional
        // default states play (idle / gesture "none"). This is what makes the Gesture layer (stretch/
        // glance) and mode-driven states actually fire in the office.
        sm.bindViewModelInstance(vmi);
        m = { artboard, sm, vmi, key: '', dirty: true, moving: false, settle: 0, cache: null, cctx: null };
        members.set(name, m);
      }
      return m;
    }

    return {
      advance(dt, present) {
        // drop instances for members who left (their cache canvas goes with them)
        for (const name of [...members.keys()]) if (!present.has(name)) members.delete(name);
        for (const [name, { node, pose }] of present) {
          const m = ensure(name);
          const r = officeToRig(node, pose);
          const key = spriteKey(r);
          if (key !== m.key) m.settle = SETTLE_FRAMES; // an input flipped — let the transition play out
          m.key = key;
          m.moving = pose.moving;
          // A member is dirty (needs a live Rive advance + re-render) while moving, while settling after a
          // change, or before it has ever been cached. Otherwise it's a stable seat — skip Rive entirely
          // and blit its cached frame in `draw`. This is the single largest Rive cost saver (ADR 086 #2):
          // during a walk only the 0–1 movers (+ any settling member) run the state machine; the rest hold.
          // An in-place gesture (stretch/glance) is stationary but must keep advancing while it plays, so
          // it's dirty for its whole window — not just the SETTLE_FRAMES after the key flip.
          m.dirty = pose.moving || pose.gesture !== 0 || m.settle > 0 || m.cache === null;
          if (!m.dirty) continue;
          if (m.settle > 0) m.settle--;
          m.vmi.color('accentColor')!.value = argbUint(r.accentColor);
          m.vmi.color('accentDark')!.value = argbUint(r.accentDark);
          m.vmi.color('skinColor')!.value = argbUint(r.skinColor);
          // Human-hair tint + style — present only once the .riv adds a `hairColor` bind / `hairStyle`
          // input (see rig.ts); guarded so they are no-ops against the current asset and activate
          // automatically when the properties land.
          setColorIfPresent(m.vmi, 'hairColor', argbUint(r.hairColor));
          setNumberIfPresent(m.vmi, 'hairStyle', r.hairStyle);
          m.vmi.number('agentVis')!.value = r.agentVis;
          m.vmi.number('humanVis')!.value = r.humanVis;
          m.vmi.number('carryVis')!.value = r.carryVis;
          m.vmi.number('mode')!.value = r.mode;
          m.vmi.number('facing')!.value = r.facing;
          m.vmi.number('run')!.value = r.run;
          // In-place gesture overlay — guarded, so it no-ops until the `.riv` exposes a `gesture` input +
          // Gesture layer (ADR 086 Phase 2 tail) and lights up automatically on the next asset export.
          setNumberIfPresent(m.vmi, 'gesture', r.gesture);
          // An urgent (running) walk plays its cycle faster — visibly hurried legs/bob.
          const step = dt * (r.run ? 1.8 : 1);
          m.sm.advance(step);
          m.artboard.advance(step);
        }
      },
      has: (name) => members.has(name),
      draw(ctx, name, feetX, feetY, spriteH) {
        const m = members.get(name);
        if (!m) return;
        const scale = spriteH / ARTBOARD_H;
        const w = ARTBOARD_W * scale;
        const h = ARTBOARD_H * scale;
        // A still member is integer-aligned to kill subpixel blur (ADR 086); a mover keeps sub-pixel
        // placement so its travel stays smooth rather than shimmering frame to frame.
        const ox = feetX - FEET_X * w;
        const oy = feetY - FEET_Y * h;
        const dx = m.moving ? ox : Math.round(ox);
        const dy = m.moving ? oy : Math.round(oy);
        if (m.dirty || !m.cache) {
          // Live render: draw the artboard to the shared offscreen, blit it, and snapshot it into the
          // member's cache so subsequent idle frames can reuse it without touching Rive.
          renderer.clear();
          renderer.save();
          renderer.scale(SS, SS);
          m.artboard.draw(renderer);
          renderer.restore();
          renderer.flush();
          // canvas-advanced batches its 2D commands until its frame handler runs; since the office drives
          // its own rAF, resolve Rive's frame explicitly or the offscreen stays blank.
          rive.resolveAnimationFrame?.();
          if (!m.cache) {
            m.cache = document.createElement('canvas');
            m.cache.width = offscreen.width;
            m.cache.height = offscreen.height;
            m.cctx = m.cache.getContext('2d');
          }
          if (m.cctx) {
            m.cctx.clearRect(0, 0, m.cache.width, m.cache.height);
            m.cctx.drawImage(offscreen, 0, 0);
          }
          m.dirty = false;
          ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, dx, dy, w, h);
        } else {
          // Stable seat: blit the cached frame — no Rive advance, no re-render.
          ctx.drawImage(m.cache, 0, 0, m.cache.width, m.cache.height, dx, dy, w, h);
        }
      },
      dispose() {
        members.clear();
      },
    };
  } catch (e) {
    console.info('[office] rive rig failed to load — using the code-drawn avatar', e);
    return null; // WASM/asset/API failure → office keeps the code-drawn avatar
  }
}
