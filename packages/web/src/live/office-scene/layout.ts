import type { Dir } from './types';

/**
 * The office floor plan: 12 desk slots distributed across the interior + edges (mixed facings), a rich
 * break nook (back-right), a glass entrance (front-left), two huddle spaces, and big floor plants —
 * ported from the Figma "Floor Plan" frame. Anchors are logical floor coords (iso.ts, FLOOR=900).
 * Zones (nook / entrance / huddles) are kept clear of desks so the room reads uncluttered.
 */

/** Unit "forward" vector (logical dx,dy) for each facing — shared by drawing and the actor system. */
export const FWD: Record<Dir, [number, number]> = {
  S: [0, 1],
  N: [0, -1],
  E: [1, 0],
  W: [-1, 0],
};

/** Logical offset from a desk centre to where its member sits/stands (opposite the facing). */
export const SEAT_BACK = 40;

export interface DeskSlot {
  id: number;
  /** Desk centre (logical). */
  lx: number;
  ly: number;
  /** Which way the seated member faces — decides monitor + member draw order. */
  dir: Dir;
}

export const DESK_SLOTS: DeskSlot[] = [
  { id: 0, lx: 150, ly: 150, dir: 'S' },
  { id: 1, lx: 330, ly: 150, dir: 'S' },
  { id: 2, lx: 470, ly: 160, dir: 'E' },
  { id: 3, lx: 150, ly: 330, dir: 'E' },
  { id: 4, lx: 350, ly: 340, dir: 'N' },
  { id: 5, lx: 620, ly: 440, dir: 'N' },
  { id: 6, lx: 780, ly: 430, dir: 'W' },
  { id: 7, lx: 150, ly: 610, dir: 'N' },
  { id: 8, lx: 360, ly: 545, dir: 'N' },
  { id: 9, lx: 780, ly: 630, dir: 'W' },
  { id: 10, lx: 340, ly: 735, dir: 'S' },
  { id: 11, lx: 650, ly: 760, dir: 'N' },
];

/** The break nook — where `away` members drift; also the broadcast megaphone spot. */
export const NOOK = { lx: 700, ly: 190 };

/** How many overflow-queue / nook avatars render individually before the rest collapse into a "+N" pill,
 * so a very large roster stays bounded instead of marching avatars off the floor. */
export const STRIP_CAP = 6;
export const NOOK_CAP = 6;

/** The glass entrance (front-left edge) — the enter/exit path endpoint + overflow strip anchor. */
export const ENTRANCE = { lx: 185, ly: 815 };

export interface Huddle {
  lx: number;
  ly: number;
  rug: string;
  poufs: [string, string, string];
}

export const HUDDLES: Huddle[] = [
  { lx: 255, ly: 470, rug: '#7fb4aa', poufs: ['#f06d5a', '#e3a72b', '#8b6fd6'] },
  { lx: 525, ly: 625, rug: '#cc7a52', poufs: ['#59c3a3', '#e86a9a', '#4da3e0'] },
];

export interface Plant {
  lx: number;
  ly: number;
  species: 'snake' | 'fiddle';
}

export const PLANTS: Plant[] = [
  { lx: 70, ly: 110, species: 'snake' },
  { lx: 470, ly: 55, species: 'fiddle' },
  { lx: 855, ly: 130, species: 'fiddle' },
  { lx: 60, ly: 720, species: 'fiddle' },
  { lx: 855, ly: 760, species: 'snake' },
  { lx: 540, ly: 855, species: 'fiddle' },
];
