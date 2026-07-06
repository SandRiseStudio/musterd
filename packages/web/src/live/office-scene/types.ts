import type { ActTone } from '../format';

/** Facing on the isometric floor. S = toward the viewer (front), N = away, E/W = profiles. */
export type Dir = 'S' | 'E' | 'N' | 'W';

/**
 * A team member projected into the office. Richer than the constellation's `GLNode`: it carries the
 * full presence/activity so the scene can decide seated-vs-away-vs-gone and working-vs-idle.
 */
export interface OfficeNode {
  name: string;
  kind: 'agent' | 'human';
  presence: 'online' | 'away' | 'offline';
  activity: 'offline' | 'online' | 'working';
  state: string | null;
  /** The member's signature colour — `memberColor(name, kind)`, an `hsl()` string. */
  color: string;
  role: string;
}

/** The office has no arcs — relationships show as choreography, not edges. */
export interface OfficeData {
  nodes: OfficeNode[];
}

/** A thought/urgency bubble over an actor's head while it's mid-choreography. */
export type Bubble = '?' | '!' | null;

/**
 * Where and how a member's avatar draws *this frame*. A member is always an actor: at their home seat
 * when idle, or interpolated along a walk during choreography — so a walker depth-sorts against desks
 * correctly and its label follows it. `carry` draws a handed box (handoff); `bubble` a raised-hand cue.
 */
export interface Pose {
  lx: number;
  ly: number;
  dir: Dir;
  small: boolean;
  carry: boolean;
  bubble: Bubble;
  /** Draw opacity — ramps 0→1 entering the office and 1→0 leaving (door staging); 1 otherwise. */
  alpha: number;
  /** True while travelling along a walk leg (drives the Rive `walking` mode); false when seated/holding. */
  moving: boolean;
  /** True while the active walk is an urgent run (drives the Rive `run` modifier). */
  run: boolean;
  /** An in-place ambient gesture playing this frame (ADR 086 Phase 2 tail): `0` none · `1` stretch ·
   * `2` glance. Drives the Rive `gesture` overlay layer; self-generated filler, cleared by a real act.
   * No-op against a `.riv` without the `gesture` input (the guarded write in rive-rig.ts). */
  gesture: number;
}

/** Motion intensity == notification tier (memory: travel-intensity == notification tiers). */
export type Tier = 'ambient' | 'needs-attn' | 'urgent';

/**
 * A live act projected to office choreography. M1 renders every event as a lightweight cue (a tinted
 * screen pulse + glyph at the relevant desk); M2 plays the real walk/carry/megaphone motion.
 */
export type OfficeEvent =
  | { kind: 'screen-pulse'; who: string; tone: ActTone }
  | { kind: 'note'; from: string; to: string; tone: ActTone }
  | { kind: 'walk-help'; from: string; to: string; tier: Tier }
  | { kind: 'walk-handoff'; from: string; to: string; label: string }
  | { kind: 'megaphone'; from: string }
  | { kind: 'accept'; who: string }
  | { kind: 'decline'; who: string }
  | { kind: 'wait'; who: string }
  | { kind: 'resolve'; who: string }
  // An act's body, typed out over the sender's head then faded — any act with a body (message, status,
  // handoff, lane, …). Independent of the choreography cue above; both can fire for one act.
  | { kind: 'speech'; who: string; text: string; tone: ActTone };

/** Identical shape to the constellation's `ConstellationHandle` — a drop-in for `ConstellationGL`. */
export interface OfficeHandle {
  update: (data: OfficeData) => void;
  emit: (ev: OfficeEvent) => void;
  dispose: () => void;
  /** Fire an in-place ambient gesture now on an idle desk member (`1` stretch · `2` glance), bypassing
   * the 90–180s ambient scheduler. Returns the member it played on, or null if none was eligible.
   * A design-preview / verification affordance (see office-preview); the live office uses the scheduler. */
  pokeGesture: (kind?: number) => string | null;
}
