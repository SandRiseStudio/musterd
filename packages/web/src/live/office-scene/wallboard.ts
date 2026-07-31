import type { LaneBoard, LaneState } from '@musterd/protocol';

/**
 * The wall board's data shape — the real lane board squinted at from across the room.
 *
 * The office's agile board (the object that replaced the dry-erase whiteboard) can't render titles:
 * at /live's ~0.52 scale anything under ~10 logical units is an unreadable smear, so a lane becomes
 * a *sticky note* — a colored rectangle in the right column — and the board communicates entirely
 * through where the paper is. That is honest kanban: you read a real board across an office the
 * same way.
 *
 * Columns mirror `Board.tsx` COLUMNS exactly (the overlay the click opens), so what you glimpse on
 * the wall and what you get up close are the same board at two distances: `ready_for_review` folds
 * into `awaiting_acceptance` (ADR 192) and `abandoned` has no column.
 */
export interface WallSticky {
  /** Stable per-lane hash — seeds the placement jitter so notes don't reshuffle on repaint. */
  seed: number;
  state: LaneState;
}

export interface WallBoardColumn {
  key: LaneState;
  /** True lane count — the badge shows this when it exceeds what the wall can pin. */
  count: number;
  /** At most STICKY_CAP notes, board order preserved. */
  stickies: WallSticky[];
}

export type WallBoard = WallBoardColumn[];

/** Column order on the wall — one-to-one with Board.tsx COLUMNS. */
export const WALL_COLUMNS: readonly LaneState[] = [
  'open',
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'done',
];

/** How many stickies fit down one wall column before the count badge takes over. */
export const STICKY_CAP = 4;

/** Tiny stable string hash (FNV-1a, 32-bit) — placement jitter only, zero crypto pretensions. */
export function laneSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Project the real lane board down to what the wall can carry. Null in, null out. */
export function projectWallBoard(board: LaneBoard | null): WallBoard | null {
  if (!board) return null;
  const byState = new Map<LaneState, WallBoardColumn>(
    WALL_COLUMNS.map((key) => [key, { key, count: 0, stickies: [] }]),
  );
  for (const lane of board.lanes) {
    const key = lane.state === 'ready_for_review' ? 'awaiting_acceptance' : lane.state;
    const col = byState.get(key);
    if (!col) continue; // abandoned — no column
    col.count++;
    if (col.stickies.length < STICKY_CAP) {
      col.stickies.push({ seed: laneSeed(lane.id), state: lane.state });
    }
  }
  return WALL_COLUMNS.map((key) => byState.get(key)!);
}
