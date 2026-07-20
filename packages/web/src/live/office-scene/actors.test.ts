import { describe, expect, it } from 'vitest';
import { createActors, homePoses, travelDir } from './actors';
import { COFFEE_STAND, ENTRANCE, NOOK, NOOK_CAP, NOOK_RUG_R, STRIP_CAP } from './layout';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';

function node(name: string, presence: OfficeNode['presence'] = 'online'): OfficeNode {
  return {
    name,
    kind: 'human',
    presence,
    activity: 'working',
    posture: presence === 'online' ? 'working' : presence,
    state: null,
    color: 'hsl(200, 60%, 60%)',
    role: '',
  };
}
function world(nodes: OfficeNode[]) {
  const placements = assignSeats(nodes);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  return { placements, byName };
}

describe('travelDir', () => {
  it('faces the dominant axis of travel', () => {
    expect(travelDir(0, 0, 10, 0)).toBe('E');
    expect(travelDir(0, 0, -10, 0)).toBe('W');
    expect(travelDir(0, 0, 0, 10)).toBe('S');
    expect(travelDir(0, 0, 0, -10)).toBe('N');
    expect(travelDir(0, 0, 10, 3)).toBe('E'); // |dx| >= |dy| → horizontal wins
  });
});

describe('homePoses', () => {
  it('is deterministic and independent of roster order', () => {
    const w1 = world([node('Ada'), node('Bo'), node('Cy')]);
    const w2 = world([node('Cy'), node('Ada'), node('Bo')]);
    const a = homePoses(w1.placements, w1.byName);
    const b = homePoses(w2.placements, w2.byName);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [name, pose] of a) expect(b.get(name)).toEqual(pose);
  });

  it('seats present members full-size and sends away members to the nook (small)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo', 'away')]);
    const poses = homePoses(placements, byName);
    expect(poses.get('Ada')!.small).toBe(false);
    expect(poses.get('Bo')!.small).toBe(true);
  });

  it('omits offline (gone) members', () => {
    const { placements, byName } = world([node('Ada'), node('Gone', 'offline')]);
    const poses = homePoses(placements, byName);
    expect(poses.has('Ada')).toBe(true);
    expect(poses.has('Gone')).toBe(false);
  });

  it('queues overflow (past the 12 desks) single-file receding from the entrance', () => {
    // 15 present-and-working members → 3 spill past the 12 desks onto the entrance queue.
    const nodes = Array.from({ length: 15 }, (_, i) => node(`M${String(i).padStart(2, '0')}`));
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const strip = [...placements.entries()]
      .flatMap(([name, p]) => (p.kind === 'strip' ? [{ name, index: p.index, pose: poses.get(name)! }] : []))
      .sort((a, b) => a.index - b.index);

    expect(strip.length).toBeGreaterThanOrEqual(2);
    for (const s of strip) expect(s.pose.small).toBe(true); // queued avatars render small
    // single file: each spot steps further into the room (x up, logical y up toward the desks)
    for (let i = 1; i < strip.length; i++) {
      expect(strip[i]!.pose.lx).toBeGreaterThan(strip[i - 1]!.pose.lx);
      expect(strip[i]!.pose.ly).toBeLessThan(strip[i - 1]!.pose.ly);
    }
    // the head of the queue waits right by the entrance
    const head = strip[0]!.pose;
    expect(Math.hypot(head.lx - ENTRANCE.lx, head.ly - ENTRANCE.ly)).toBeLessThan(120);
  });

  it('caps the queue avatars past STRIP_CAP (rest collapse into the "+N" pill)', () => {
    // 12 desks + a big overflow → only STRIP_CAP queued avatars get a pose; the rest are placed but undrawn.
    const nodes = Array.from({ length: 12 + STRIP_CAP + 4 }, (_, i) => node('Q' + String(i).padStart(2, '0')));
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const strip = [...placements.entries()].filter(([, p]) => p.kind === 'strip');
    const stripDrawn = strip.filter(([name]) => poses.has(name));
    expect(strip.length).toBe(STRIP_CAP + 4); // 4 over the cap
    expect(stripDrawn.length).toBe(STRIP_CAP); // only the cap is drawn
  });

  it('caps the nook avatars past NOOK_CAP', () => {
    const nodes = Array.from({ length: NOOK_CAP + 3 }, (_, i) => node('A' + String(i).padStart(2, '0'), 'away'));
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    const drawn = nodes.filter((n) => poses.has(n.name));
    expect(drawn.length).toBe(NOOK_CAP);
  });

  it('clusters away members compactly on the nook rug', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E'].map((n) => node(n, 'away'));
    const { placements, byName } = world(nodes);
    const poses = homePoses(placements, byName);
    for (const n of nodes) {
      const p = poses.get(n.name)!;
      expect(p.small).toBe(true);
      // inside the nook rug (an iso diamond about the nook anchor)
      expect(Math.abs(p.lx - NOOK.lx) + Math.abs(p.ly - NOOK.ly)).toBeLessThan(NOOK_RUG_R);
    }
  });
});

describe('walk choreography', () => {
  it('walks a mover away from home and returns it, going idle when done', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    expect(actors.active()).toBe(true);

    // partway through the first leg the mover has left its seat
    actors.step(0.2);
    const mid = actors.poses().get('Ada')!;
    expect(mid.lx !== home.lx || mid.ly !== home.ly).toBe(true);

    // run the trip to completion (there → hold → back)
    let guard = 0;
    while (actors.active() && guard++ < 2000) actors.step(0.05);
    expect(actors.active()).toBe(false);

    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 5);
    expect(back.ly).toBeCloseTo(home.ly, 5);
    expect(back.carry).toBe(false);
    expect(back.bubble).toBeNull();
  });

  it("won't play a walk when the target isn't present", () => {
    const { placements, byName } = world([node('Ada')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.walk('Ada', { kind: 'help', to: 'Ghost', urgent: false })).toBe(false);
    expect(actors.active()).toBe(false);
  });

  it('carries a box on a handoff outbound leg', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.walk('Ada', { kind: 'handoff', to: 'Bo', urgent: false });
    actors.step(0.1);
    expect(actors.poses().get('Ada')!.carry).toBe(true);
  });
});

describe('locomotion smoothness', () => {
  /** Shortest signed arc between two angles — mirror of the actor system's wrap-aware turn. */
  const arc = (a: number, b: number): number => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  it('cruises at one continuous speed through waypoints — never a dead stop mid-run', () => {
    // A populated room so the stroll routes around furniture into a multi-leg polyline.
    const { placements, byName } = world(['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fi'].map((n) => node(n)));
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientWalk('Ada')).toBe(true);

    const dt = 1 / 60;
    let prev = actors.poses().get('Ada')!;
    const speeds: number[] = [];
    let guard = 0;
    // Sample the outbound run — it ends when the walker parks at the machine (`moving` flips false).
    while (guard++ < 4000) {
      actors.step(dt);
      const p = actors.poses().get('Ada')!;
      if (!p.moving && speeds.length > 0) break;
      if (p.moving) speeds.push(Math.hypot(p.lx - prev.lx, p.ly - prev.ly) / dt);
      prev = p;
    }
    expect(speeds.length).toBeGreaterThan(20);

    const vmax = Math.max(...speeds);
    const first = speeds.findIndex((s) => s >= 0.9 * vmax);
    const last = speeds.length - 1 - [...speeds].reverse().findIndex((s) => s >= 0.9 * vmax);
    expect(first).toBeGreaterThanOrEqual(0);
    // Between the ramp-in and the ramp-out the run holds cruise speed. The old per-leg easeInOut braked
    // to ~0 at every string-pulled waypoint — exactly the "walk a few steps, pause, walk again" read.
    for (let i = first; i <= last; i++) {
      expect(speeds[i]!).toBeGreaterThan(0.7 * vmax);
    }
  });

  it('swivels the facing through turns — per-frame heading change is rate-bounded, never a snap', () => {
    const { placements, byName } = world(['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fi'].map((n) => node(n)));
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientWalk('Ada')).toBe(true);

    const dt = 1 / 60;
    let prev = actors.poses().get('Ada')!.heading;
    expect(prev).toBeDefined();
    let maxDelta = 0;
    let turned = 0;
    let guard = 0;
    while (actors.active() && guard++ < 4000) {
      actors.step(dt);
      const h = actors.poses().get('Ada')!.heading;
      expect(h).toBeDefined();
      const d = Math.abs(arc(prev!, h!));
      maxDelta = Math.max(maxDelta, d);
      turned += d;
      prev = h;
    }
    // TURN_RATE is 9 rad/s — one frame may turn at most 9·dt (plus float slack).
    expect(maxDelta).toBeLessThanOrEqual(9 * dt + 1e-6);
    // …and the trip genuinely turned (out, about-face at the machine, and back into the seat).
    expect(turned).toBeGreaterThan(Math.PI / 2);
  });
});

describe('ambient micro-choreography', () => {
  const settle = (a: ReturnType<typeof createActors>) => {
    let g = 0;
    while (a.active() && g++ < 2000) a.step(0.05);
  };

  it('strolls a desk member out to the coffee stand and back home, going idle when done', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.ambientWalk('Ada')).toBe(true);
    expect(actors.ambientOnly()).toBe(true);

    // it wanders toward the break-nook machine at some point in the trip
    let nearest = Infinity;
    let guard = 0;
    while (actors.active() && guard++ < 2000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada');
      if (p) nearest = Math.min(nearest, Math.hypot(p.lx - COFFEE_STAND.lx, p.ly - COFFEE_STAND.ly));
    }
    expect(nearest).toBeLessThan(10); // paused at the coffee stand mid-trip

    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 3);
    expect(back.ly).toBeCloseTo(home.ly, 3);
    expect(actors.ambientOnly()).toBe(false); // no walks left
    expect(actors.active()).toBe(false);
  });

  it('ambientOnly reflects only self-generated motion (false at rest and during a real walk)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.ambientOnly()).toBe(false); // at rest

    actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false });
    actors.step(0.1);
    expect(actors.ambientOnly()).toBe(false); // a real walk is in flight
  });

  it('only offers idle desk members (excludes away/nook and the already-strolling)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Zoe', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    expect(actors.idleDeskMembers().sort()).toEqual(['Ada', 'Bo']); // Zoe is in the nook (small)

    expect(actors.ambientWalk('Ada')).toBe(true);
    expect(actors.idleDeskMembers()).toEqual(['Bo']); // Ada is now busy
    expect(actors.ambientWalk('Zoe')).toBe(false); // nook members don't stroll
    expect(actors.ambientWalk('Ada')).toBe(false); // already strolling
  });

  it('cancelAmbient yields: drops the beat and walks the stroller straight home', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    actors.ambientWalk('Ada');
    actors.step(0.6); // out on the floor
    expect(actors.ambientOnly()).toBe(true);

    actors.cancelAmbient();
    expect(actors.ambientOnly()).toBe(false); // no longer an ambient walk…
    expect(actors.active()).toBe(true); // …but a return-home walk is in flight
    settle(actors);
    const back = actors.poses().get('Ada')!;
    expect(back.lx).toBeCloseTo(home.lx, 3);
    expect(back.ly).toBeCloseTo(home.ly, 3);
  });

  it('a real act preempts an in-flight stroll instantly — the trip starts now, not after ambling home', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const bo = homePoses(placements, byName).get('Bo')!;

    actors.ambientWalk('Ada');
    actors.step(0.6); // Ada is out on the floor mid-stroll
    expect(actors.ambientOnly()).toBe(true);

    // a real help walk must replace the stroll immediately (not queue behind a yield-home leg)
    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    expect(actors.ambientOnly()).toBe(false); // the stroll was replaced by the real walk

    // and the real trip actually plays: Ada reaches Bo's desk, proving she didn't amble home first
    let nearBo = Infinity;
    let g = 0;
    while (actors.active() && g++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      nearBo = Math.min(nearBo, Math.hypot(p.lx - bo.lx, p.ly - bo.ly));
    }
    expect(nearBo).toBeLessThan(80);
  });

  it('a real act also preempts the yield-home return left by cancelAmbient', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const bo = homePoses(placements, byName).get('Bo')!;

    actors.ambientWalk('Ada');
    actors.step(0.6);
    actors.cancelAmbient(); // stroll → low-priority yield-home walk
    expect(actors.ambientOnly()).toBe(false);
    expect(actors.active()).toBe(true);

    expect(actors.walk('Ada', { kind: 'help', to: 'Bo', urgent: false })).toBe(true);
    let nearBo = Infinity;
    let g = 0;
    while (actors.active() && g++ < 4000) {
      actors.step(0.05);
      const p = actors.poses().get('Ada')!;
      nearBo = Math.min(nearBo, Math.hypot(p.lx - bo.lx, p.ly - bo.ly));
    }
    expect(nearBo).toBeLessThan(80); // the help trip ran despite the pending yield-home
  });

  it('plays an in-place gesture on an idle desk member, then clears it (no movement)', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    const home = actors.poses().get('Ada')!;

    expect(actors.gestureBeat('Ada', 1)).toBe(true);
    expect(actors.active()).toBe(true);
    expect(actors.ambientOnly()).toBe(true); // a gesture is ambient filler

    // the pose carries the gesture but the member does NOT move (stationary beat)
    actors.step(0.3);
    const mid = actors.poses().get('Ada')!;
    expect(mid.gesture).toBe(1);
    expect(mid.lx).toBeCloseTo(home.lx, 5);
    expect(mid.ly).toBeCloseTo(home.ly, 5);
    expect(mid.moving).toBe(false);

    // it ends on its own; the member returns to a plain idle pose (gesture 0)
    let g = 0;
    while (actors.active() && g++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
    expect(actors.active()).toBe(false);
  });

  it('only gestures eligible idle desk members, and excludes a gesturing one from the idle pool', () => {
    const { placements, byName } = world([node('Ada'), node('Bo'), node('Zoe', 'away')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);

    expect(actors.gestureBeat('Zoe', 1)).toBe(false); // nook (small) members don't gesture
    expect(actors.gestureBeat('Ada', 1)).toBe(true);
    expect(actors.gestureBeat('Ada', 2)).toBe(false); // already gesturing
    expect(actors.idleDeskMembers()).toEqual(['Bo']); // Ada is busy gesturing
  });

  it('a real act preempts an in-place gesture', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);
    actors.gestureBeat('Ada', 1);
    expect(actors.ambientOnly()).toBe(true);
    actors.cancelAmbient();
    expect(actors.active()).toBe(false); // the gesture was dropped
    expect(actors.poses().get('Ada')!.gesture).toBe(0);
  });

  it('a no-op roster refresh does not interrupt an in-flight stroll', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName, true);

    actors.ambientWalk('Ada');
    actors.step(0.6);
    expect(actors.ambientOnly()).toBe(true);

    actors.setHomes(placements, byName, true); // identical roster (a poll) — must not yank Ada back
    expect(actors.ambientOnly()).toBe(true);
  });
});

describe('presence transitions', () => {
  const settle = (a: ReturnType<typeof createActors>) => {
    let g = 0;
    while (a.active() && g++ < 2000) a.step(0.05);
  };

  it('walks an arrival in from the entrance to its seat', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, true); // first call always snaps
    const w2 = world([node('Ada'), node('Bo')]);
    const home = homePoses(w2.placements, w2.byName).get('Bo')!;
    actors.setHomes(w2.placements, w2.byName, true);

    expect(actors.active()).toBe(true);
    const start = actors.poses().get('Bo')!;
    expect(Math.hypot(start.lx - home.lx, start.ly - home.ly)).toBeGreaterThan(50); // near the door
    settle(actors);
    const end = actors.poses().get('Bo')!;
    expect(end.lx).toBeCloseTo(home.lx, 3);
    expect(end.ly).toBeCloseTo(home.ly, 3);
    expect(actors.nodes().has('Bo')).toBe(true);
  });

  it('walks a departure out to the door, then drops it', () => {
    const actors = createActors();
    const w1 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w1.placements, w1.byName, true);
    const w2 = world([node('Ada')]);
    actors.setHomes(w2.placements, w2.byName, true);

    expect(actors.active()).toBe(true);
    // still drawn (as a retained ghost) while walking out
    expect(actors.nodes().has('Bo')).toBe(true);
    expect(actors.poses().has('Bo')).toBe(true);
    settle(actors);
    // gone once it reaches the door
    expect(actors.nodes().has('Bo')).toBe(false);
    expect(actors.poses().has('Bo')).toBe(false);
  });

  it('drifts to the nook (small) when a member goes away', () => {
    const actors = createActors();
    const present = world([node('Ada'), node('Bo')]);
    actors.setHomes(present.placements, present.byName, true);
    const away = world([node('Ada'), node('Bo', 'away')]);
    const nookHome = homePoses(away.placements, away.byName).get('Bo')!;
    actors.setHomes(away.placements, away.byName, true);

    expect(actors.active()).toBe(true);
    settle(actors);
    const end = actors.poses().get('Bo')!;
    expect(end.lx).toBeCloseTo(nookHome.lx, 3);
    expect(end.ly).toBeCloseTo(nookHome.ly, 3);
    expect(end.small).toBe(true); // nook avatars are small
  });

  it('snaps without animating when animate=false (reduced motion)', () => {
    const actors = createActors();
    const w1 = world([node('Ada')]);
    actors.setHomes(w1.placements, w1.byName, true);
    const w2 = world([node('Ada'), node('Bo')]);
    actors.setHomes(w2.placements, w2.byName, false);
    expect(actors.active()).toBe(false);
    const home = homePoses(w2.placements, w2.byName).get('Bo')!;
    expect(actors.poses().get('Bo')!.lx).toBeCloseTo(home.lx, 3);
  });
});

describe('door staging', () => {
  it('counts a door pulse per arrival/departure and clears on read (none on first snap)', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true); // first call snaps
    expect(actors.takeDoorPulses()).toBe(0);

    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true); // Bo arrives
    expect(actors.takeDoorPulses()).toBe(1);
    expect(actors.takeDoorPulses()).toBe(0); // cleared

    actors.setHomes(one.placements, one.byName, true); // Bo departs
    expect(actors.takeDoorPulses()).toBe(1);
  });

  it('counts arrivals separately from departures (the dog only gets up for arrivals)', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true); // first call snaps
    expect(actors.takeArrivals()).toBe(0);

    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true); // Bo arrives
    expect(actors.takeArrivals()).toBe(1);
    expect(actors.takeArrivals()).toBe(0); // cleared
    actors.takeDoorPulses(); // (drain the pulse the arrival raised — the two counters read independently)

    actors.setHomes(one.placements, one.byName, true); // Bo departs — a door pulse, but not an arrival
    expect(actors.takeDoorPulses()).toBe(1);
    expect(actors.takeArrivals()).toBe(0);
  });

  it('fades an arrival in from transparent to opaque', () => {
    const actors = createActors();
    const one = world([node('Ada')]);
    actors.setHomes(one.placements, one.byName, true);
    const two = world([node('Ada'), node('Bo')]);
    actors.setHomes(two.placements, two.byName, true);

    expect(actors.poses().get('Bo')!.alpha).toBeLessThan(0.2); // just emerged from the door
    let g = 0;
    while (actors.active() && g++ < 2000) actors.step(0.05);
    expect(actors.poses().get('Bo')!.alpha).toBe(1); // seated, fully opaque
  });
});
