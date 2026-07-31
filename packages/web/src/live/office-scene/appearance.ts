/**
 * The character wardrobe — who a member *looks like*, derived deterministically from their name.
 *
 * Pure and renderer-free, like `skeleton.ts`: `appearanceOf(name, kind, color) → Appearance` returns a
 * complete description of a person (skin, hair, facial hair, hat, top, trousers, shoes), and `character.ts`
 * paints it. Nothing here is random at runtime — every choice is a salted hash of the member's name, so a
 * teammate looks the same across every frame, every reload, and every machine, exactly like their seat and
 * their signature colour do.
 *
 * ## The one thing that is NOT free: the top's hue
 *
 * A member's `color` (`memberColor(name, kind)`) is **identity**, not decoration — it is the same hue as
 * their roster dot, their label, and their desk, and it is how you pick miley out of a crowded floor at a
 * glance. So the **top keeps the identity hue** and varies by *pattern and cut* instead (tee, stripes,
 * hoodie, vest, long-sleeve). Everything else — skin, hair, facial hair, hats, trousers, shoes — runs free.
 * You still know who's who; nobody is a clone.
 *
 * The agent/human tell (ADR 079) also stays load-bearing and survives the wardrobe: **agents have an
 * antenna + chest LED + visor** (readable from any facing, even the back of the head), humans have eyes and
 * may have facial hair. A hat does not hide an antenna — it pokes through, which is the correct joke.
 */

import type { OfficeNode } from './types';

/**
 * FNV-1a, salted, with a proper avalanche — one independent stable stream of choices per member.
 *
 * The finalizer is load-bearing and used not to be. With FNV's single `h ^= h >>> 15`, the streams
 * for different salts stayed correlated on structured names, and `Math.floor(hash × len)` collapsed
 * into a few buckets: measured over 400 names, the `hoodie` top cut came up **zero times** and
 * `long` sleeves seven, while `stripe`/`vest` took most of the floor. Every "pick from a list" in
 * this file was quietly drawing from about half its palette.
 *
 * `fmix32` (murmur3's finalizer) is what makes the salts genuinely independent. Note this **changes
 * everyone's existing look** — it is a reshuffle, not a redesign, and the wardrobe was always
 * "stable per name", never "these specific people look like this".
 */
function hash(name: string, salt: number): number {
  let h = (2166136261 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Pick from a list by a salted hash of the name — stable forever, uncorrelated across salts. */
function pick<T>(list: readonly T[], name: string, salt: number): T {
  return list[Math.floor(hash(name, salt) * list.length)]!;
}

/** Perceived brightness of a `#rrggbb`, 0–1 (Rec. 601 — good enough, and cheap). */
function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/**
 * Pick a hair colour that actually *reads* against this skin.
 *
 * With a full-rainbow skin palette, an independent hair pick will sooner or later put green hair on a green
 * head — and at 30px that isn't a person, it's a blob. So we walk the palette from the hashed starting point
 * and take the first colour with enough brightness separation from the skin. Still deterministic (same name
 * → same hair), still uncorrelated in *which* colour you get; it just refuses the invisible ones.
 */
const MIN_CONTRAST = 0.22;
/** Walk a palette from a hashed start and take the first entry that separates from `against`. */
function pickContrasting(palette: readonly string[], name: string, salt: number, against: string): string {
  const start = Math.floor(hash(name, salt) * palette.length);
  const l = luma(against);
  for (let i = 0; i < palette.length; i++) {
    const c = palette[(start + i) % palette.length]!;
    if (Math.abs(luma(c) - l) >= MIN_CONTRAST) return c;
  }
  // Nothing in the palette separates enough (a mid-tone skin) — fall back to the extremes, which always do.
  return l > 0.5 ? '#221a14' : '#e8dcc8';
}

/**
 * Skin, from deep browns through to mint and lavender. Deliberately **not** a "realistic" ramp: these are
 * stylised block people in a stylised office, and a floor where everyone is a slightly different beige is
 * both duller and a worse look than one where people are plainly, cheerfully different. The natural tones
 * and the fantastical ones sit in one list on purpose, so no member is ever "the odd one out".
 */
const SKINS = [
  '#f7d9b8',
  '#f0c9a0',
  '#e8b07d',
  '#d99b62',
  '#c68642',
  '#a9683a',
  '#8d5524',
  '#6b3f1f',
  '#4e2c14',
  '#9fd8b8', // mint
  '#8ed1c9', // seafoam
  '#a9c6f0', // periwinkle
  '#c9b6f5', // lavender
  '#e8a8d8', // orchid
  '#f2a6a6', // coral
  '#f5cf6e', // gold
  '#9db8c9', // slate
  '#b8d97a', // moss
] as const;

const HAIR_COLORS = [
  '#221a14', // black
  '#3d2a1c', // dark brown
  '#6b4a2b', // brown
  '#a06c38', // auburn
  '#d8b45c', // blonde
  '#e8dcc8', // platinum
  '#b0b6bb', // grey
  '#8a3a2e', // red
  '#3f6fa8', // blue
  '#2f8f7a', // teal
  '#a8478f', // magenta
  '#6b4ea8', // violet
  '#4f8a3a', // green
  '#e07a3f', // orange
] as const;

/** Hair silhouettes. These must read at ~30px, so they differ by *shape*, not by strand detail. */
export type HairStyle = 'bald' | 'buzz' | 'short' | 'side' | 'bob' | 'long' | 'ponytail' | 'afro' | 'bun';
const HAIR_STYLES: readonly HairStyle[] = ['bald', 'buzz', 'short', 'side', 'bob', 'long', 'ponytail', 'afro', 'bun'];

export type FacialHair = 'none' | 'stubble' | 'moustache' | 'goatee' | 'beard';
/** Weighted toward `none` — a floor where everyone has a beard is as uniform as one where nobody does. */
const FACIAL_HAIR: readonly FacialHair[] = ['none', 'none', 'none', 'none', 'stubble', 'moustache', 'goatee', 'beard'];

/**
 * How a member presents. This exists for one reason: the floor read as entirely male (nick,
 * 2026-07-30, "none of our characters or members have long hair/look like a woman"), and the two
 * things that fix that pull in opposite directions unless something coordinates them — hair long
 * enough to read as long, and **no facial hair on a femme character**.
 *
 * Picking hair and beard from independent hashes (which is what the rest of this file does, on
 * purpose) cannot express that constraint: it will cheerfully deal a beard to a ponytail. So this is
 * the one axis the wardrobe coordinates around, and it stays deliberately coarse — presentation is
 * hair and facial hair, nothing else. Skin, top, trousers, shoes, hats, glasses and headphones all
 * keep running free off their own salts, because none of those belong to a gender.
 *
 * `neutral` is a real third option rather than a rounding error: those members draw from the whole
 * hair pool and can wear stubble, which is what stops the floor sorting into two tidy camps.
 */
export type Presents = 'femme' | 'masc' | 'neutral';
const PRESENTS: readonly Presents[] = ['femme', 'femme', 'femme', 'masc', 'masc', 'masc', 'neutral'];

/** Long silhouettes. A femme character draws from these, so "looks like a woman" is legible at 30px
 *  — where the ONLY thing that reads is the shape of the head against the shoulders. */
const FEMME_HAIR: readonly HairStyle[] = ['bob', 'long', 'ponytail', 'bun', 'long', 'bob', 'afro'];
/** Short and mid silhouettes. `side` and `short` carry most of this, with a bald/buzz minority. */
const MASC_HAIR: readonly HairStyle[] = ['buzz', 'short', 'side', 'bald', 'short', 'side', 'afro'];

export type Hat = 'none' | 'cap' | 'beanie' | 'band';
/** Hats are the rarest thing on the floor, so they stay a small delight rather than a uniform. */
const HATS: readonly Hat[] = ['none', 'none', 'none', 'none', 'none', 'cap', 'beanie', 'band'];
const HAT_COLORS = ['#d1503f', '#2f7f6a', '#3f6fa8', '#e1ad01', '#8a5fd6', '#2a2118', '#e8dcc8', '#e07a3f'] as const;

/**
 * The cut of the top. `sleeves` is the one that does real visual work: a short sleeve leaves the forearm
 * **bare skin**, which — on a 90px character — is a bigger, clearer difference than any pattern.
 */
export type TopCut = 'tee' | 'long' | 'stripe' | 'hoodie' | 'vest';
const TOP_CUTS: readonly TopCut[] = ['tee', 'long', 'stripe', 'hoodie', 'vest'];

const BOTTOMS = [
  '#3f5570', // denim
  '#2b3038', // charcoal
  '#7a6a4f', // khaki
  '#4a5a3a', // olive
  '#6b3f52', // plum
  '#5a5f66', // grey
  '#8a4a32', // rust
  '#2f4a4a', // teal
  '#7d6b8f', // mauve
] as const;

const SHOES = ['#f2eee6', '#22262b', '#d1503f', '#2f4a70', '#a9683a', '#2f8f7a', '#e1ad01'] as const;

/**
 * A small personal accessory — the per-person "quirk" that turns a dressed body into a *character*. Kept
 * rare (weighted toward `none`) so it stays a delight, not a uniform, and drawn in its own cosy colour so
 * it never competes with the identity hue on the top. Glasses need a face, so agents (who wear a visor
 * across theirs) never get them — they can still wear headphones or a scarf.
 */
export type Accessory = 'none' | 'glasses' | 'headphones' | 'scarf';
const ACCESSORIES: readonly Accessory[] = ['none', 'none', 'none', 'none', 'none', 'glasses', 'glasses', 'headphones', 'scarf'];
const AGENT_ACCESSORIES: readonly Accessory[] = ['none', 'none', 'none', 'none', 'none', 'headphones', 'headphones', 'scarf'];
/** Cosy, saturated accessory tones (scarf wool / headphone shells) — a warm set, deliberately off the
 * identity hue so the accessory reads as *a thing they own*, not part of their colour signature. */
const ACCESSORY_COLORS = ['#d1503f', '#e08a43', '#e1ad01', '#2f8f7a', '#3f6fa8', '#8a5fd6', '#c85a7a', '#4f8a3a'] as const;

/** Neutral presentation stops at stubble — a full beard reads as a definite choice, and `neutral`
 *  is deliberately the option that does not make one. */
const NEUTRAL_FACIAL_HAIR: readonly FacialHair[] = ['none', 'none', 'none', 'stubble'];

/** A gentle per-person smile for humans — some beam wide, some just turn the corners up. */
export type Smile = 'soft' | 'wide';
const SMILES: readonly Smile[] = ['soft', 'soft', 'wide'];

export interface Appearance {
  skin: string;
  hair: HairStyle;
  hairColor: string;
  facialHair: FacialHair;
  hat: Hat;
  hatColor: string;
  /** The cut of the top. The *hue* is not here — it is the member's identity colour (see the file docs). */
  cut: TopCut;
  /** True when the forearms are bare (short sleeves) — the strongest small-scale variation we have. */
  bareArms: boolean;
  bottom: string;
  shoes: string;
  /** The per-person quirk (glasses/headphones/scarf) — see `Accessory`. */
  accessory: Accessory;
  /** The accessory's own cosy colour — never the identity hue. */
  accessoryColor: string;
  /** How a human smiles (agents smile through their visor instead). */
  smile: Smile;
  /** Presentation — coordinates hair length with facial hair. See {@link Presents}. */
  presents: Presents;
}

/**
 * A member's complete look. Every field is an independent salted hash of the name, so hair colour doesn't
 * correlate with skin, hats don't correlate with beards, and so on — the floor looks like a room of people
 * rather than a row of palette swatches.
 */
export function appearanceOf(node: Pick<OfficeNode, 'name' | 'kind'>): Appearance {
  const { name, kind } = node;
  const presents = pick(PRESENTS, name, 14);
  const hair =
    presents === 'femme' ? pick(FEMME_HAIR, name, 3)
    : presents === 'masc' ? pick(MASC_HAIR, name, 3)
    : pick(HAIR_STYLES, name, 3);
  const cut = pick(TOP_CUTS, name, 8);
  const skin = pick(SKINS, name, 1);
  return {
    skin,
    hair,
    // Both hair and hats are picked to *contrast with the skin*. With a full-rainbow skin palette an
    // independent pick eventually lands teal hair (or a teal beanie) on a teal head — which at 30px is not
    // a person, it is a blob. Both shipped once; the character sheet caught them.
    hairColor: pickContrasting(HAIR_COLORS, name, 4, skin),
    // Agents wear a visor across the face, so facial hair would have nowhere to read — and a bearded robot
    // muddies the one tell the office cannot afford to lose.
    // Agents wear a visor, so facial hair has nowhere to read; a femme character never has any. The
    // second rule is why `presents` exists at all — independent hashes deal beards to ponytails.
    facialHair:
      kind === 'agent' || presents === 'femme' ? 'none'
      : presents === 'neutral' ? pick(NEUTRAL_FACIAL_HAIR, name, 5)
      : pick(FACIAL_HAIR, name, 5),
    hat: pick(HATS, name, 6),
    hatColor: pickContrasting(HAT_COLORS, name, 7, skin),
    cut,
    bareArms: cut === 'tee' || cut === 'vest',
    bottom: pick(BOTTOMS, name, 9),
    shoes: pick(SHOES, name, 10),
    // Agents can't wear glasses over a visor — same reason they get no facial hair.
    accessory: pick(kind === 'agent' ? AGENT_ACCESSORIES : ACCESSORIES, name, 11),
    accessoryColor: pick(ACCESSORY_COLORS, name, 12),
    smile: pick(SMILES, name, 13),
    presents,
  };
}
