import type { LaneState, Posture, WorkingHours } from '@musterd/protocol';
import type { ActTone } from '../format';
import type { Addressee } from './speech';
import type { WallBoard } from './wallboard';

/** Facing on the isometric floor. S = toward the viewer (front), N = away, E/W = profiles. */
export type Dir = 'S' | 'E' | 'N' | 'W';

/**
 * A team member projected into the office. Richer than the constellation's `GLNode`: it carries the
 * full presence/activity so the scene can decide seated-vs-away-vs-gone and working-vs-idle.
 */
export interface OfficeNode {
  name: string;
  kind: 'agent' | 'human';
  /**
   * A `kind: 'service'` roster seat (ADR 232 — autorefresh, guardian). Pure code: no model, no
   * harness attestation. The BODY stays an agent (`kind` above is the drawing decision), but the
   * nameplate must say "service" rather than render the unknown-provider "?" — a ledger seat with
   * a question mark reads as a broken attestation, not as what it is.
   */
  service: boolean;
  presence: 'online' | 'away' | 'offline';
  activity: 'offline' | 'active' | 'working';
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
  /** Live presence surface (harness) — for the floating nameplate identity line. */
  surface: string | null;
  /** Harness-attested model id (ADR 101) — for the floating nameplate identity line. */
  model: string | null;
  /** What they are on: freshest in-flight lane title or status line (see `workingOn.ts`). */
  workTitle: string | null;
  workSource: 'lane' | 'status' | null;
  laneState: LaneState | null;
  moreLanes: number;
  /** Self-set do-not-disturb (ADR 044) — at their desk, headphones on, never walked to (§4). */
  dnd: boolean;
  /** Why the seat is dark (ADR 141/315) — drives the owned-desk texture and the left_team exit. */
  offline_reason: string | null;
  /** Last seen (wire fact) — the warm-desk fade and the desk-capacity tiebreak read it. */
  last_seen_at: number | null;
}

/** The office has no arcs — relationships show as choreography, not edges. */
export interface OfficeData {
  /** Stable visual seed for desk moods; absent in previews, where the default seed is used. */
  teamName?: string;
  /** Optional Team schedule rendered by the wall sign; absent means no sign. */
  teamWorkingHours?: WorkingHours | null;
  nodes: OfficeNode[];
  /** The lane board projected for the wall's agile board (wallboard.ts). Absent/null → empty board. */
  wallBoard?: WallBoard | null;
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
  /** Continuous facing in radians on the logical floor (E=0, S=π/2 — the angles of `layout.FWD`).
   * Eased at a turn rate by the actor system so a direction change is a swivel, never a snap; `dir`
   * stays the quantized cardinal for the 4-way legibility reads (billboard face, monitors, labels).
   * Absent → render by `dir` alone. */
  heading?: number;
  small: boolean;
  /** What's in the hands this frame: a handoff box, an errand's plate/bottle/mug — or nothing. */
  carry: CarryKind | null;
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
  /** Sort this pose at another point's depth while seated (`sit > 0.5`) — an errand sitter on the couch
   * composite-sorts with it exactly like a leisure placement's `depthAt` (see `layout.LeisureSpot`). */
  depthAt?: { lx: number; ly: number };
}

/** What a member can carry through a walk or a hold: the handoff box, or an errand's prop. */
export type CarryKind = 'box' | 'plate' | 'bottle' | 'mug' | 'phone';

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
  /** `of`: whose work was accepted (the act's recipient) — the celebration lands on THEM, not the
   *  acceptor. Null/absent for team-addressed accepts, where there is no single celebrant. */
  | { kind: 'accept'; who: string; of?: string | null }
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
  /** A plain-language caption line for the lower-third rail (first-five-seconds §2). */
  | { kind: 'caption'; text: string }
  // An act, typed out over the sender's head then faded — the body when it has one, else the act label.
  // Independent of the choreography cue above; both can fire for one act. `id` (the envelope id) makes
  // the bubble a click-through to the same act in the stream panel.
  // `act` (the wire act name) lets the bubble shape act-aware — status chatter gets a tighter glance.
  // `addressee` names who a DIRECTED act is aimed at, so "You were right, I'll take the handoff…"
  // can't float unaddressed; null for team/broadcast, where the audience is already the default.
  | {
      kind: 'speech';
      who: string;
      text: string;
      tone: ActTone;
      id?: string;
      act?: string;
      addressee?: Addressee | null;
    };

/** The imperative handle the `OfficeScene` component drives the mounted scene through. */
export interface OfficeHandle {
  update: (data: OfficeData) => void;
  emit: (ev: OfficeEvent) => void;
  dispose: () => void;
  /** Park/resume the render loop while the panel is collapsed (canvas stays mounted at opacity 0).
   * Suspended: no rAF, no ambient beats — zero draw cost for invisible pixels. Resuming re-bakes and
   * paints one fresh frame synchronously, so re-expanding is still instant. */
  setSuspended: (on: boolean) => void;
  /** Fire an in-place ambient gesture now on an idle desk member (a `GESTURE` kind), bypassing the
   * ambient scheduler. Returns the member it played on, or null if none was eligible.
   * A design-preview / verification affordance (see office-preview); the live office uses the scheduler. */
  pokeGesture: (kind?: number) => string | null;
  /** Fire an errand now on an idle desk member (bypassing the scheduler): the fridge meal, the water
   * refill, the coffee run, or a phone call. Same verification affordance as `pokeGesture`. */
  pokeErrand: (kind: 'fridge' | 'water' | 'coffee' | 'phone') => string | null;
  /** Cumulative render counters, for a capture harness probing the scene from CDP (see
   * `scripts/perf/broadcast-baseline.mjs`). `ticks` counts rAF callbacks, `draws` counts the ones that
   * actually painted — under broadcast the gap is the draw-rate cap (capture fps); without it they
   * were equal (full rAF waste). Two integer increments per frame; not gated, because gating costs
   * more than it saves. */
  stats: () => OfficeStats;
  /** The shared ambient beat log (E1 spec §5): one entry per fired slot — slot number, whose beat,
   * and whether this browser played it. Two visible viewers of the same team over the same interval
   * must agree on everything but `played`. Capped at the last 200 entries. */
  ambientLog: () => AmbientLogEntry[];
}

/** @see OfficeHandle.ambientLog */
export interface AmbientLogEntry {
  slot: number;
  kind: 'pet' | 'pair' | 'member';
  who?: string;
  pair?: [string, string];
  /** Whether THIS browser's local guards let the beat run — the one honest per-viewer field. */
  played: boolean;
}

/** @see OfficeHandle.stats */
export interface OfficeStats {
  /** rAF callbacks entered since the scene mounted. */
  ticks: number;
  /** Frames actually painted (`ticks` minus the ones coalesced away by the ambient FPS budget). */
  draws: number;
  /** `performance.now()` when the scene mounted — the denominator for a rate. */
  since: number;
}
