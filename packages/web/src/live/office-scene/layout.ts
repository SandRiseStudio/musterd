import type { Dir } from './types';

/**
 * The office floor plan (M1): 12 desk slots distributed across the interior and edges, mixed facings,
 * around a central break nook, with a glass entrance at the front. Anchors are logical floor coords
 * (see iso.ts, FLOOR=900). Ported from the Figma "Floor Plan" frame; kept as individual desks for M1
 * (shared benches/L-pods are an M3 fidelity pass).
 */

export interface DeskSlot {
  id: number;
  /** Desk centre (logical). */
  lx: number;
  ly: number;
  /** Which way the seated member faces — decides monitor + member draw order. */
  dir: Dir;
}

export const DESK_SLOTS: DeskSlot[] = [
  { id: 0, lx: 165, ly: 150, dir: 'S' },
  { id: 1, lx: 340, ly: 150, dir: 'S' },
  { id: 2, lx: 560, ly: 150, dir: 'E' },
  { id: 3, lx: 740, ly: 175, dir: 'W' },
  { id: 4, lx: 150, ly: 360, dir: 'E' },
  { id: 5, lx: 335, ly: 385, dir: 'N' },
  { id: 6, lx: 745, ly: 385, dir: 'W' },
  { id: 7, lx: 150, ly: 585, dir: 'E' },
  { id: 8, lx: 745, ly: 585, dir: 'W' },
  { id: 9, lx: 320, ly: 720, dir: 'S' },
  { id: 10, lx: 470, ly: 735, dir: 'N' },
  { id: 11, lx: 640, ly: 720, dir: 'S' },
];

/** The break nook — where `away` members drift; also the broadcast megaphone spot. */
export const NOOK = { lx: 460, ly: 470 };

/** The glass entrance (front edge) — the enter/exit path endpoint and the overflow strip anchor. */
export const ENTRANCE = { lx: 470, ly: 845 };

export interface Plant {
  lx: number;
  ly: number;
  species: 'snake' | 'fiddle';
}

export const PLANTS: Plant[] = [
  { lx: 70, ly: 120, species: 'snake' },
  { lx: 840, ly: 110, species: 'fiddle' },
  { lx: 70, ly: 640, species: 'fiddle' },
  { lx: 850, ly: 700, species: 'snake' },
  { lx: 470, ly: 60, species: 'fiddle' },
];
