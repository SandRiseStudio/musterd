import { describe, expect, it } from 'vitest';
import { createActors, homePoses, travelDir } from './actors';
import { ENTRANCE, NOOK, NOOK_CAP, STRIP_CAP } from './layout';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';

function node(name: string, presence: OfficeNode['presence'] = 'online'): OfficeNode {
  return { name, kind: 'human', presence, activity: 'working', state: null, color: 'hsl(200, 60%, 60%)', role: '' };
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
      // inside the nook rug (an iso diamond of "radius" 132 about the nook anchor)
      expect(Math.abs(p.lx - NOOK.lx) + Math.abs(p.ly - NOOK.ly)).toBeLessThan(132);
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
