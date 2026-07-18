import type { Posture } from '@musterd/protocol';
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
  activity: 'offline' | 'idle' | 'working';
  /**
   * The composed roster posture (ADR 138) — resolved **once, by the same `memberPosture` the roster rail
   * uses**, and carried here so the floor can't drift from the chip. It decides both where the member is
   * placed (desk / leisure / nook / gone — see `seating.ts`) and the colour of their name dot.
   */
  posture: Posture;
  state: string | null;
  /** The member's signature colour — `memberColor(name, kind)`, an `hsl()` string. */
  color: string;
  role: string;
}

/** The office has no arcs — relationships show as choreography, not edges. */
export interface OfficeData {
  /** Stable visual seed for desk moods; absent in previews, where the default seed is used. */
  teamName?: string;
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
  /** True while travelling along a walk leg (drives the walk cycle); false when seated/holding. */
  moving: boolean;
  /** True while the active walk is an urgent run (longer stride, deeper lean, harder arm drive). */
  run: boolean;
  /** An in-place ambient gesture playing this frame (ADR 086 Phase 2 tail): `0` none · `1` stretch ·
   * `2` glance. Self-generated filler, cleared by a real act. */
  gesture: number;
  /** Progress through the current gesture's window, 0→1 — so the beat arcs in and out instead of snapping. */
  gestureT: number;
  /**
   * Gait phase in [0,1). **Advanced by distance travelled, not by wall time** (`STRIDE` logical units per
   * cycle) — a stride is a fixed length of *floor*, so the feet plant on it. Drive this off a clock instead
   * and the legs cycle at a rate unrelated to the body's speed, which is exactly what makes a character
   * look like it is skating rather than walking. It persists across legs so a walker doesn't hitch at a
   * waypoint, and keeps its value while standing so the next departure starts from the foot it stopped on.
   */
  phase: number;
  /**
   * How much of the walk cycle is expressed, 0→1. Eased rather than switched, so a walker *settles* out of
   * its stride into a stand instead of the legs popping from mid-step to attention the frame a leg ends.
   */
  stride: number;
  /**
   * Seated blend, 0 standing → 1 folded onto the chair. Eased, so arriving at a desk is a member sitting
   * *down* and leaving is them standing *up*; a boolean here would teleport them into the chair.
   */
  sit: number;
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
  // The ADR 103 steering trio. `steer` is interrupt-class (always interrupts, newest supersedes) so it
  // reads as loud as an urgent help — a room-wide sweep plus, when directed, an urgent redirect run to
  // the target. `challenge` is an epistemic "justify?" question over the head(s). `defer` mutates the
  // plan (a Goal, `meta.goal_id`) so it pulses across the board in the lane family.
  | { kind: 'steer'; from: string; to: string | null; urgent: boolean }
  | { kind: 'challenge'; from: string; to: string | null; urgent: boolean }
  | { kind: 'defer'; who: string }
  // An act, typed out over the sender's head then faded — the body when it has one, else the act label.
  // Independent of the choreography cue above; both can fire for one act. `id` (the envelope id) makes
  // the bubble a click-through to the same act in the stream panel.
  // `act` (the wire act name) lets the bubble shape act-aware — status chatter gets a tighter glance.
  | { kind: 'speech'; who: string; text: string; tone: ActTone; id?: string; act?: string };

/** The imperative handle the `OfficeScene` component drives the mounted scene through. */
export interface OfficeHandle {
  update: (data: OfficeData) => void;
  emit: (ev: OfficeEvent) => void;
  dispose: () => void;
  /** Fire an in-place ambient gesture now on an idle desk member (`1` stretch · `2` glance), bypassing
   * the 90–180s ambient scheduler. Returns the member it played on, or null if none was eligible.
   * A design-preview / verification affordance (see office-preview); the live office uses the scheduler. */
  pokeGesture: (kind?: number) => string | null;
}
