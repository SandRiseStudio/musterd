import { describe, expect, it } from 'vitest';
import { createActors, homePoses, travelDir } from './actors';
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
});

describe('walk choreography', () => {
  it('walks a mover away from home and returns it, going idle when done', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName);
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
    actors.setHomes(placements, byName);
    expect(actors.walk('Ada', { kind: 'help', to: 'Ghost', urgent: false })).toBe(false);
    expect(actors.active()).toBe(false);
  });

  it('carries a box on a handoff outbound leg', () => {
    const { placements, byName } = world([node('Ada'), node('Bo')]);
    const actors = createActors();
    actors.setHomes(placements, byName);
    actors.walk('Ada', { kind: 'handoff', to: 'Bo', urgent: false });
    actors.step(0.1);
    expect(actors.poses().get('Ada')!.carry).toBe(true);
  });
});
