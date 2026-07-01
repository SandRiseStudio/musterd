import type { OfficeNode, Pose } from './types';

/**
 * The Rive integration contract. `character.riv` (authored via the Rive MCP — see
 * docs/design/office-rive-character-spec.md) exposes a `Character` view model whose instance values ARE
 * the input channel. At runtime the office sets these per member each frame; the state machine + data
 * bindings do the rest. This module is the pure mapping from our office data → those values, so it's
 * unit-testable without the asset or a browser.
 *
 * As-built (differs from the spec's original hue/isHuman draft — reconciled in the spec §3/§5):
 * colours are real `color` properties (not a hue number), and agent/human/carry visibility are `0|1`
 * numbers bound to shape opacity (the code translates `kind`/`carry`, since Rive's simple databind has
 * no boolean→opacity converter).
 */
export interface RigInputs {
  /** torso tint — `#aarrggbb`. */
  accentColor: string;
  /** arms tint — a darker shade of the accent. */
  accentDark: string;
  /** head tint — a skin/casing swatch seeded from the name. */
  skinColor: string;
  /** agent-tell opacity (antenna/LED/visor): 1 for agents, 0 for humans. */
  agentVis: number;
  /** human-tell opacity (hair/eyes): 1 for humans, 0 for agents. */
  humanVis: number;
  /** carry-box opacity: 1 while handing off, else 0. */
  carryVis: number;
  /** state-machine selector: 0 idle · 1 working · 2 walking · 3 away · 4 help. */
  mode: number;
  /** facing: 0 S · 1 E · 2 N · 3 W (rig is front-only in v1; passed for forward-compat). */
  facing: number;
  /** run modifier (urgent walk): 0|1. */
  run: number;
}

/** FNV-ish name hash — same idiom as seating/memberColor, so skin choice is stable per person. */
function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/** hsl(H,S%,L%) → `#ffRRGGBB`. Mirrors `memberColor`'s output so the rig tint matches the constellation. */
export function hslToArgb(hsl: string, lightnessScale = 1): string {
  const m = /hsl\(\s*([-\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)/.exec(hsl);
  if (!m) return '#ff000000';
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Math.max(0, Math.min(1, (Number(m[3]) / 100) * lightnessScale));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, '0');
  return `#ff${hx(r)}${hx(g)}${hx(b)}`;
}

/** Small skin/casing swatch set (seeded by name) — realistic + stylised, matching the Figma rig. */
const SKINS = ['#fff0c9a0', '#ffd9a066', '#ffa86b3c', '#ff6b4423'];
export function skinFor(name: string): string {
  return SKINS[hash(name) % SKINS.length]!;
}

/** Primary state selector. Priority: away > help > walking > working > idle (spec §5). */
export function modeFor(node: OfficeNode, pose: Pose): number {
  if (node.presence === 'away') return 3;
  if (pose.bubble !== null) return 4;
  if (pose.moving) return 2;
  if (node.activity === 'working') return 1;
  return 0;
}

const FACING: Record<Pose['dir'], number> = { S: 0, E: 1, N: 2, W: 3 };

/** Map a member's live data + pose to the Rive `Character` view-model values. */
export function officeToRig(node: OfficeNode, pose: Pose): RigInputs {
  const human = node.kind === 'human';
  return {
    accentColor: hslToArgb(node.color),
    accentDark: hslToArgb(node.color, 0.72),
    skinColor: skinFor(node.name),
    agentVis: human ? 0 : 1,
    humanVis: human ? 1 : 0,
    carryVis: pose.carry ? 1 : 0,
    mode: modeFor(node, pose),
    facing: FACING[pose.dir],
    run: pose.run ? 1 : 0,
  };
}
