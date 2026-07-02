import RiveCanvas from '@rive-app/canvas-advanced';
import riveWasmUrl from '@rive-app/canvas-advanced/rive.wasm?url';
import { officeToRig } from './rig';
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

/** `#aarrggbb` → uint32 ARGB (Rive colour value). */
function argbUint(hex: string): number {
  return parseInt(hex.slice(1), 16) >>> 0;
}

interface Member {
  artboard: { advance(s: number): boolean; draw(r: unknown): void; bindViewModelInstance(v: unknown): void };
  sm: { advance(s: number): boolean };
  vmi: { number(p: string): { value: number }; color(p: string): { value: number } | null | undefined };
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
        m = { artboard, sm, vmi };
        members.set(name, m);
      }
      return m;
    }

    return {
      advance(dt, present) {
        // drop instances for members who left
        for (const name of [...members.keys()]) if (!present.has(name)) members.delete(name);
        for (const [name, { node, pose }] of present) {
          const m = ensure(name);
          const r = officeToRig(node, pose);
          m.vmi.color('accentColor')!.value = argbUint(r.accentColor);
          m.vmi.color('accentDark')!.value = argbUint(r.accentDark);
          m.vmi.color('skinColor')!.value = argbUint(r.skinColor);
          // Human-hair tint — present only once the .riv adds a `hairColor` bind (see rig.ts); guarded so
          // it is a no-op against the current asset and activates automatically when the property lands.
          setColorIfPresent(m.vmi, 'hairColor', argbUint(r.hairColor));
          m.vmi.number('agentVis').value = r.agentVis;
          m.vmi.number('humanVis').value = r.humanVis;
          m.vmi.number('carryVis').value = r.carryVis;
          m.vmi.number('mode').value = r.mode;
          m.vmi.number('facing').value = r.facing;
          m.vmi.number('run').value = r.run;
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
        renderer.clear();
        renderer.save();
        renderer.scale(SS, SS);
        m.artboard.draw(renderer);
        renderer.restore();
        renderer.flush();
        // canvas-advanced batches its 2D commands until its frame handler runs; since the office drives
        // its own rAF, resolve Rive's frame explicitly or the offscreen stays blank.
        rive.resolveAnimationFrame?.();
        const scale = spriteH / ARTBOARD_H;
        const w = ARTBOARD_W * scale;
        const h = ARTBOARD_H * scale;
        ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, feetX - FEET_X * w, feetY - FEET_Y * h, w, h);
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
