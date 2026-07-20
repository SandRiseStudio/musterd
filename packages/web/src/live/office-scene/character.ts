import { appearanceOf, type Appearance } from './appearance';
import { project, type Fit, type Pt } from './iso';
import { FWD } from './layout';
import { CHAR, type Skel, type V3 } from './skeleton';
import type { Dir, OfficeNode } from './types';

/**
 * The character painter: flattens a `Skel` (3D joints, see `skeleton.ts`) onto the 2:1 iso canvas and
 * dresses it in an `Appearance` (see `appearance.ts`).
 *
 * Deliberately dumb about *motion* — every curve lives in the skeleton — so it stays swappable: this is
 * the file a future 3D renderer replaces, while the walk cycle and the sit survive it.
 *
 * Three things it does own, all of them spatial rather than animated:
 *  - **Facing.** Character space (+z forward, +x right) is rotated onto the floor by the member's facing,
 *    so one skeleton serves all four directions — no mirrored art, no baked profiles.
 *  - **Self-occlusion.** Limbs are depth-sorted *within* the character by their own world depth, so the
 *    near arm swings in front of the torso and the far arm behind it, at every facing, with no per-facing
 *    special cases. Far limbs shade down a touch, which is what stops a flat figure reading as a cut-out.
 *  - **The wardrobe.** Trousers, shoes, sleeves, hair, hats, facial hair. All of it must survive being
 *    ~40px tall, so everything differs by **silhouette and block colour**, never by fine detail.
 */

/** Torso thickness. Kept under 2×`CHAR.shoulderW` so the arms hang outside the body's silhouette. Nudged
 * 25 → 27 for the charm pass: a rounder, softer body to sit under the slightly larger head. */
const TORSO_W = 27;

/** Darken/lighten an `hsl()` string by a lightness factor (mirrors render.ts's `hslL`). */
function hslL(color: string, f: number): string {
  const m = /hsl\(\s*([\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%/.exec(color);
  if (!m) return color;
  const [, h, s, l] = m;
  return `hsl(${h}, ${s}%, ${Math.max(0, Math.min(100, Number(l) * f))}%)`;
}
/** Multiply a `#rrggbb` toward black — the far-side shading for hex wardrobe colours. */
function shade(hex: string, f: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
/** A limb on the character's far side — a cheap, effective depth cue for a flat-filled figure. */
const FAR = 0.82;

/** Where a character-space joint lands on screen, and how deep it is on the floor. */
interface Proj {
  p: Pt;
  d: number;
}

/**
 * Project one joint. Character space (x right, y up, z forward) is rotated onto the floor by the facing,
 * added to the member's floor point, projected, then lifted by the joint's height.
 */
function projector(lx: number, ly: number, dir: Dir, fit: Fit, s: number, heading?: number): (j: V3) => Proj {
  // A continuous heading rotates the basis to any angle mid-turn; the cardinal is the resting case.
  const f: readonly [number, number] = heading !== undefined ? [Math.cos(heading), Math.sin(heading)] : FWD[dir];
  const r: [number, number] = [f[1], -f[0]]; // the character's right, on the floor
  return (j: V3): Proj => {
    const wx = lx + (f[0] * j.z + r[0] * j.x) * s;
    const wy = ly + (f[1] * j.z + r[1] * j.x) * s;
    const p = project(wx, wy, fit);
    return { p: { x: p.x, y: p.y - j.y * s * fit.scale }, d: wx + wy };
  };
}

/** A limb segment: a rounded bar from a→b. Flat-filled and capped, to sit with the blocky furniture. */
function bone(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, w: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, c: Pt, rx: number, ry: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

export interface CharacterOpts {
  lx: number;
  ly: number;
  dir: Dir;
  node: OfficeNode;
  skel: Skel;
  /** Continuous facing (radians, logical floor space) — overrides `dir`'s cardinal basis mid-turn. */
  heading?: number;
  /** Uniform size multiplier — nook/queue actors render at 0.72. */
  size: number;
  alpha: number;
  carry: boolean;
  /** Scene clock (s) and the member's seed — the face's own small life: a blink, an LED pulse. */
  t: number;
  seed: number;
}

/**
 * How open the eyes are, 0→1. A blink is *fast* (~130ms) and rare (every 4–8s, seeded per member), which
 * is precisely why it registers as alive rather than as a twitch — you never quite catch it happening.
 */
function blink(t: number, seed: number): number {
  const period = 4 + seed * 4;
  const p = (t + seed * 20) % period;
  if (p > 0.13) return 1;
  return Math.abs(p - 0.065) / 0.065;
}

/**
 * Draw a member. `armsOnly` re-draws just the arms — the seated overlay pass, which paints the forearms
 * *over* the desk they are resting on (a seated member's whole arm is above the desk surface, so once the
 * desk slab has been painted the arms belong on top of it). See `renderScene`.
 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  o: CharacterOpts,
  armsOnly = false,
): void {
  const { skel: k, node, dir, size } = o;
  const px = projector(o.lx, o.ly, dir, fit, size, o.heading);
  const u = fit.scale * size; // one logical unit, in screen px, at this character's size
  const look = appearanceOf(node);
  const acc = node.color; // the identity hue — the top, and only the top
  const accDark = hslL(acc, 0.72);

  const prev = ctx.globalAlpha;
  if (o.alpha < 1) ctx.globalAlpha = Math.max(0, o.alpha);

  interface Part {
    d: number;
    fn: () => void;
  }
  const parts: Part[] = [];
  const chestD = px(k.chest).d;

  // ── an arm: sleeve to the elbow, then either sleeve or bare skin to the wrist ──
  const arm = (i: 0 | 1): Part => {
    const sh = px(k.shoulder[i]);
    const el = px(k.elbow[i]);
    const wr = px(k.wrist[i]);
    const d = (sh.d + el.d + wr.d) / 3;
    const back = d < chestD;
    // A short sleeve leaves the forearm bare. On a 90-unit character that is a bigger, clearer difference
    // than any pattern — it changes the arm's *colour*, not its texture.
    const sleeve = back ? hslL(accDark, FAR) : accDark;
    const fore = look.bareArms
      ? back
        ? shade(look.skin, FAR)
        : look.skin
      : sleeve;
    const hand = back ? shade(look.skin, FAR) : look.skin;
    return {
      d,
      fn: () => {
        bone(ctx, sh.p, el.p, 8.4 * u, sleeve);
        bone(ctx, el.p, wr.p, 7.2 * u, fore);
        disc(ctx, wr.p, 4.4 * u, 4.1 * u, hand); // a soft mitten hand — rounder reads friendlier
      },
    };
  };

  // ── a leg: trouser to the ankle, then a shoe ──
  const leg = (i: 0 | 1): Part => {
    const hp = px(k.hip[i]);
    const kn = px(k.knee[i]);
    const an = px(k.ankle[i]);
    const d = (hp.d + kn.d + an.d) / 3;
    const back = d < px(k.pelvis).d;
    const trouser = back ? shade(look.bottom, FAR) : look.bottom;
    const shoe = back ? shade(look.shoes, FAR) : look.shoes;
    return {
      d,
      fn: () => {
        bone(ctx, hp.p, kn.p, 9.8 * u, trouser);
        bone(ctx, kn.p, an.p, 8.6 * u, trouser);
        // The shoe: a small slab pointing the way the character faces, with a rounded toe.
        const toe = px({ x: k.ankle[i].x, y: 1.5, z: k.ankle[i].z + 6.5 });
        bone(ctx, an.p, toe.p, 6.6 * u, shoe);
        disc(ctx, toe.p, 3.3 * u, 2.6 * u, shoe); // a soft rounded toe cap
      },
    };
  };

  if (armsOnly) {
    for (const p of [arm(0), arm(1)].sort((a, b) => a.d - b.d)) p.fn();
    if (o.carry) drawCarry(ctx, px, k, u);
    ctx.globalAlpha = prev;
    return;
  }

  // Contact shadow — a warm brown, not neutral black, so the character sits in the room's golden light
  // rather than being cut out of it.
  disc(ctx, project(o.lx, o.ly, fit), 21 * u, 5.5 * u, 'rgba(64, 38, 16, 0.15)');

  parts.push(leg(0), leg(1));

  // ── the torso, in the member's identity hue, cut by their `TopCut` ──
  const pel = px(k.pelvis);
  const ch = px(k.chest);
  const nk = px(k.neck);
  const shL = px(k.shoulder[0]);
  const shR = px(k.shoulder[1]);
  parts.push({
    d: chestD,
    fn: () => {
      bone(ctx, pel.p, ch.p, TORSO_W * u, acc);
      bone(ctx, ch.p, nk.p, (TORSO_W - 5) * u, acc);
      // A soft rounded belly: a gentle bulge low on the torso so the body reads plush and cuddly rather
      // than as a straight barrel. Sits between the pelvis and chest, in the identity hue.
      const belly = { x: (pel.p.x + ch.p.x) / 2, y: pel.p.y + (ch.p.y - pel.p.y) * 0.36 };
      disc(ctx, belly, TORSO_W * 0.6 * u, TORSO_W * 0.5 * u, acc);
      bone(ctx, shL.p, shR.p, 9 * u, acc); // the shoulder line — what gives the silhouette shoulders

      if (look.cut === 'stripe') {
        // Two bands across the chest, in the identity hue's own dark — reads as a striped tee at 40px,
        // where an actual stripe pattern would just turn to mush.
        for (const f of [0.3, 0.62]) {
          const a = px({ x: -TORSO_W / 2, y: k.pelvis.y + (k.chest.y - k.pelvis.y) * f, z: k.chest.z });
          const b = px({ x: TORSO_W / 2, y: k.pelvis.y + (k.chest.y - k.pelvis.y) * f, z: k.chest.z });
          bone(ctx, a.p, b.p, 4.5 * u, accDark);
        }
      } else if (look.cut === 'vest') {
        // A darker panel down the front — a gilet over a bare-armed tee.
        const a = px({ x: 0, y: k.pelvis.y, z: k.pelvis.z + 5 });
        const b = px({ x: 0, y: k.chest.y + 2, z: k.chest.z + 5 });
        bone(ctx, a.p, b.p, 15 * u, accDark);
      } else if (look.cut === 'hoodie') {
        // The hood: a bulge behind the neck. It sits at −z, so it depth-sorts behind the head naturally.
        const hood = px({ x: 0, y: k.neck.y + 1, z: k.neck.z - 7 });
        disc(ctx, hood.p, 11 * u, 8 * u, accDark);
      }
      if (node.kind === 'agent') disc(ctx, ch.p, 3 * u, 2.8 * u, '#74e08a'); // the chest LED
    },
  });

  parts.push(arm(0), arm(1));
  parts.sort((a, b) => a.d - b.d);
  for (const p of parts) p.fn();

  // The head paints last — it is the top of the silhouette at every facing and the thing the eye reads
  // first, so it never gets clipped by an arm.
  drawHead(ctx, px, k, node, look, dir, u, acc, o.t, o.seed);
  if (o.carry) drawCarry(ctx, px, k, u);

  ctx.globalAlpha = prev;
}

/**
 * The head: neck, back hair, skull, front hair, hat, face, and the agent tell.
 *
 * Order matters and is the whole trick — hair that falls *behind* the skull (a bob's back mass, a
 * ponytail, an afro) is drawn before it, and hair that sits *on* it (the cap of every style) after. That
 * one split is what lets nine hairstyles read as nine silhouettes at 30px.
 */
function drawHead(
  ctx: CanvasRenderingContext2D,
  px: (j: V3) => Proj,
  k: Skel,
  node: OfficeNode,
  look: Appearance,
  dir: Dir,
  u: number,
  acc: string,
  t: number,
  seed: number,
): void {
  const H = k.head;
  const R = k.headR;
  const hd = px(H);
  const r = R * u;
  const hc = look.hairColor;
  // The face only reads when the character is turned toward the viewer; from behind it is just a head.
  const facingUs = dir === 'S' || dir === 'E';
  const at = (x: number, y: number, z: number): Pt => px({ x: H.x + x, y: H.y + y, z: H.z + z }).p;

  bone(ctx, px(k.neck).p, hd.p, 6 * u, shade(look.skin, 0.86)); // a short neck — the head is *carried*

  // ── a cosy scarf, wrapped round the neck under the chin (drawn before the skull so it tucks under) ──
  if (look.accessory === 'scarf') {
    const np = px(k.neck).p;
    disc(ctx, { x: np.x, y: np.y - 1 * u }, r * 1.05, r * 0.5, look.accessoryColor);
    disc(ctx, { x: np.x, y: np.y + 1.5 * u }, r * 0.86, r * 0.42, shade(look.accessoryColor, 0.86));
    // a short hanging tail, front-and-centre
    bone(ctx, { x: np.x + 2 * u, y: np.y }, { x: np.x + 3 * u, y: np.y + r * 0.9 }, 3.4 * u, look.accessoryColor);
  }

  /**
   * The face is **billboarded**: laid out in *screen* space around the head, nudged a little in the
   * direction the character faces.
   *
   * The first cut placed the eyes and visor at a `+z` offset in character space — geometrically "correct",
   * and it looked terrible. On a 2:1 iso floor **south projects to down-*left*, not straight down**, so
   * offsetting a face along its facing slides it onto the cheek: the visor read as a monocle. Leaning it
   * only "a little" toward the facing did not fix it either — it just made a smaller monocle.
   *
   * So the face does not use the projection at all. It is laid out in **pure screen space, centred on the
   * skull**, level and symmetric, like a sticker on the front of a ball. The *body* already tells you which
   * way a member is turned — the face only has to be legible, and at 25px across, legible means centred.
   */
  const face = (dx: number, dy: number): Pt => ({ x: hd.p.x + dx * r, y: hd.p.y + dy * r });

  // ── hair behind the skull ── (kept close to the skull: at r×1.5 an afro was wider than the torso)
  if (look.hair === 'afro') disc(ctx, at(0, 1.5, -1), r * 1.22, r * 1.18, hc);
  else if (look.hair === 'long') disc(ctx, at(0, -4, -2), r * 0.98, r * 1.16, hc);
  else if (look.hair === 'bob') disc(ctx, at(0, -1.5, -2), r * 1.06, r * 1.02, hc);
  else if (look.hair === 'ponytail') disc(ctx, at(0, -2, -7), r * 0.42, r * 0.72, hc);
  else if (look.hair === 'bun') disc(ctx, at(0, R + 2, -2), r * 0.46, r * 0.42, hc);

  // ── the skull ──
  disc(ctx, hd.p, r, r * 0.98, look.skin);

  // ── hair (and hats) that sit ON the skull ──
  //
  // These are drawn as a disc *clipped to the head*, pushed up by `drop`. That clip is the whole trick: two
  // overlapping circles meet in a straight line, so the visible hair is a crown with a clean **hairline**
  // across the brow at `drop/2`. Drawn as an un-clipped flat ellipse instead (as this first did), hair reads
  // as a beret balanced on a ball — the single ugliest thing on the first pass of this sheet. A bigger
  // `drop` = a higher hairline = less hair.
  const crown = (color: string, drop: number, overhang = 1) => {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(hd.p.x, hd.p.y, r * overhang, r * 0.98 * overhang, 0, 0, Math.PI * 2);
    ctx.clip();
    disc(ctx, at(0, drop, 0), r * overhang, r * 0.98 * overhang, color);
    ctx.restore();
  };

  if (look.hair !== 'bald') {
    const DROP: Record<Exclude<typeof look.hair, 'bald'>, number> = {
      buzz: 9.5, // a high, tight hairline
      short: 8,
      side: 7,
      bob: 6,
      long: 6,
      ponytail: 7,
      bun: 7,
      afro: 4.5, // a low hairline — lots of hair
    };
    crown(hc, DROP[look.hair]);
    // A side parting: a sweep of hair across one side of the brow, breaking the symmetry.
    if (look.hair === 'side') disc(ctx, at(R * 0.42, 4.5, R * 0.34), r * 0.46, r * 0.3, hc);
  }

  // ── the hat, over the hair ──
  if (look.hat === 'beanie') {
    crown(look.hatColor, 5, 1.06);
    disc(ctx, at(0, 3.5, R * 0.3), r * 1.0, r * 0.2, shade(look.hatColor, 0.82)); // the turn-up
  } else if (look.hat === 'cap') {
    crown(look.hatColor, 6, 1.04);
    // The peak, level across the brow — a cap reads as a cap by its flat front edge, not by its direction.
    if (facingUs) {
      bone(ctx, face(-0.72, -0.16), face(0.72, -0.16), r * 0.3, shade(look.hatColor, 0.78));
    }
  } else if (look.hat === 'band') {
    bone(ctx, face(-0.86, -0.3), face(0.86, -0.3), r * 0.28, look.hatColor);
  }

  // ── headphones: a band over the crown + an ear cup each side. Screen-space around the skull, so they
  // read from every facing (a member seen from behind is still visibly wearing them). ──
  if (look.accessory === 'headphones') {
    const col = look.accessoryColor;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.6 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(hd.p.x, hd.p.y - r * 0.12, r * 1.04, r * 1.06, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    disc(ctx, { x: hd.p.x - r * 0.98, y: hd.p.y + r * 0.1 }, 3.0 * u, 3.9 * u, col);
    disc(ctx, { x: hd.p.x + r * 0.98, y: hd.p.y + r * 0.1 }, 3.0 * u, 3.9 * u, col);
    disc(ctx, { x: hd.p.x - r * 0.98, y: hd.p.y + r * 0.1 }, 1.4 * u, 1.9 * u, shade(col, 0.8));
    disc(ctx, { x: hd.p.x + r * 0.98, y: hd.p.y + r * 0.1 }, 1.4 * u, 1.9 * u, shade(col, 0.8));
  }

  // ── the face — only ever drawn on the side the face is actually on ──
  // The visor used to render at *every* facing, which painted a dark plate straight through the back of
  // every agent's skull. A face belongs on a face: from behind, an agent is a head and an antenna.
  //
  // A curved mouth (a `∪` bowed downward in canvas space, whose corners turn *up*), for the warm faces.
  const smile = (halfW: number, my: number, drop: number, color: string, lw: number): void => {
    const a = face(-halfW, my);
    const b = face(halfW, my);
    const c = face(0, my + drop);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
  };
  // Rosy cheeks — the single warmest cue, and it costs two soft discs. Given to agents too (a robot that
  // blushes is exactly the quirky-cute the office is going for), tinted to their hue rather than coral.
  const cheeks = (color: string): void => {
    for (const dx of [-0.58, 0.58]) disc(ctx, face(dx, 0.34), r * 0.25, r * 0.2, color);
  };

  if (node.kind === 'agent' && facingUs) {
    cheeks('rgba(255, 150, 120, 0.32)');
    // A rounded visor housing with two friendly glowing eyes and a little smile of light in the member's
    // own hue — reads as a cheerful robot, not a security camera. The glow in their colour is still the
    // "awake across the room" tell the old slit carried.
    bone(ctx, face(-0.52, 0.04), face(0.52, 0.04), r * 0.56, '#242d33');
    for (const dx of [-0.26, 0.26]) {
      disc(ctx, face(dx, 0.02), 2.6 * u, 2.6 * u, acc);
      disc(ctx, face(dx - 0.06, -0.04), 0.9 * u, 0.9 * u, 'rgba(255,255,255,0.9)'); // catchlight
    }
    smile(0.22, 0.2, 0.12, acc, 1.7 * u);
  } else if (node.kind === 'human' && facingUs) {
    cheeks('rgba(233, 118, 100, 0.30)');
    const open = blink(t, seed);
    for (const dx of [-0.34, 0.34]) {
      disc(ctx, face(dx, 0.04), 2.3 * u, 2.5 * u * open, '#2e2a26');
      if (open > 0.6) disc(ctx, face(dx - 0.08, -0.04), 0.85 * u, 0.85 * u * open, 'rgba(255,255,255,0.85)');
    }
    // Round glasses over the eyes, with a bridge — the per-person quirk that needs a face to land on.
    if (look.accessory === 'glasses') {
      ctx.strokeStyle = '#33302a';
      ctx.lineWidth = 1.5 * u;
      for (const dx of [-0.34, 0.34]) {
        const c = face(dx, 0.04);
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, 3.2 * u, 3.1 * u, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      bone(ctx, face(-0.12, 0.02), face(0.12, 0.02), 1.1 * u, '#33302a');
    }
    // Facial hair, below the eyes and over the jaw.
    const fh = look.facialHair;
    if (fh === 'stubble') disc(ctx, face(0, 0.56), r * 0.6, r * 0.3, shade(hc, 0.72));
    else if (fh === 'beard') disc(ctx, face(0, 0.58), r * 0.64, r * 0.4, hc);
    else if (fh === 'goatee') disc(ctx, face(0, 0.66), r * 0.24, r * 0.22, hc);
    else if (fh === 'moustache') disc(ctx, face(0, 0.34), r * 0.34, r * 0.11, hc);
    // A gentle smile — but only where facial hair wouldn't swallow it (a beard/moustache hides the mouth).
    if (fh !== 'beard' && fh !== 'moustache') {
      const wide = look.smile === 'wide';
      smile(wide ? 0.32 : 0.22, 0.44, wide ? 0.2 : 0.13, '#7a4335', 1.8 * u);
    }
  }

  // ── the wisp: a curved little antenna topped with a warm firefly glow, drawn last so it pokes through any
  // hat. Once the agents' "sign of life" (a straight mast + a green LED); now every member carries one, and
  // it's the quirky-warm counterpart to the floating nameplate above — a mote that hovers over the head,
  // gently drifting and breathing. It also stays the only from-behind tell, so it must read at office scale.
  {
    const swayDir = seed % 2 === 0 ? 1 : -1;
    const base = px({ x: H.x, y: H.y + R - 1, z: H.z }).p; // just off the crown
    const top = px({ x: H.x, y: H.y + R + 11, z: H.z }).p;
    const drift = Math.sin(t * 1.05 + seed * 5) * 1.7 * u; // a firefly's idle wander
    const tx = top.x + drift;
    const ty = top.y - Math.abs(Math.sin(t * 0.9 + seed * 3)) * 1.3 * u; // and a gentle bob
    // A curved stalk in the member's own hue, bowed to one side so it reads as a whimsical antenna, not a
    // mast. The control point is offset sideways from the straight line between crown and tip.
    const cx = (base.x + tx) / 2 + swayDir * 4.6 * u;
    const cy = (base.y + ty) / 2;
    ctx.strokeStyle = acc;
    ctx.lineWidth = 1.7 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.quadraticCurveTo(cx, cy, tx, ty);
    ctx.stroke();
    // The firefly at the tip: two additive warm layers (halo + mid) glowing under a bright near-white core,
    // breathing. Additive so it reads as *light*, not a bead — the warm counterpart to the old green LED.
    const pulse = 0.72 + 0.28 * Math.sin(t * 1.7 + seed * 6);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    disc(ctx, { x: tx, y: ty }, 5.4 * u * pulse, 5.2 * u * pulse, 'rgba(245, 188, 92, 0.5)');
    disc(ctx, { x: tx, y: ty }, 3.0 * u * pulse, 2.9 * u * pulse, 'rgba(255, 214, 130, 0.55)');
    ctx.restore();
    disc(ctx, { x: tx, y: ty }, 1.7 * u, 1.7 * u, 'rgba(255, 248, 228, 0.96)');
  }
}

/** The handoff box, carried at the chest between the hands. */
function drawCarry(ctx: CanvasRenderingContext2D, px: (j: V3) => Proj, k: Skel, u: number): void {
  const c = px({ x: 0, y: k.chest.y - 1, z: k.chest.z + 13 });
  ctx.fillStyle = '#b592f0';
  ctx.fillRect(c.p.x - 11 * u, c.p.y - 9 * u, 22 * u, 17 * u);
  ctx.fillStyle = '#8a5fd6';
  ctx.fillRect(c.p.x - 11 * u, c.p.y - 9 * u, 22 * u, 5 * u);
}
