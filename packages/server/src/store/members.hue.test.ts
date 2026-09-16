import { HUE_MIN_SEPARATION, defaultHue, hueConflict, hueSeparation } from '@musterd/protocol/hue';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName, leaveMember, setMemberHue, takenHues } from './members.js';
import { toMember } from './rows.js';
import { createTeam } from './teams.js';

/**
 * The hue on a DB-only team (ADR 374). Here the daemon IS the source, so `addMember` assigns when
 * the caller says nothing (`hue` undefined), stores what it is told, and refuses a collision by
 * name. `null` is a different statement — "the file has no hue" — and is stored as null: that is
 * reconcile's word, and the daemon never argues with the file.
 */
function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  return { db, team };
}

describe('addMember hue (ADR 374)', () => {
  it('assigns a hue when none is given, and every seat on a fresh team is separated', () => {
    const { db, team } = seed();
    const hues: number[] = [];
    for (let i = 0; i < 12; i++) {
      const { row } = addMember(db, team, { name: `seat-${i}`, kind: 'agent' });
      expect(row.hue).not.toBeNull();
      hues.push(row.hue!);
    }
    for (let i = 0; i < hues.length; i++)
      for (let j = i + 1; j < hues.length; j++)
        expect(hueSeparation(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(HUE_MIN_SEPARATION);
  });

  /* gptbot's #1258 acceptance: the seed was looked up by row id, which a NEW member does not have
     yet, so every fresh seat started from `defaultHue('')` and only `assignHue` walking them apart
     hid it. The default is the NAME's (ADR 374 decision 4), and the first seat on an empty team
     must land exactly on it — nothing to walk away from. */
  it('a fresh seat seeds from its own name, not from an empty one', () => {
    const { db, team } = seed();
    expect(addMember(db, team, { name: 'miley', kind: 'agent' }).row.hue).toBe(defaultHue('miley'));
    expect(defaultHue('miley')).not.toBe(defaultHue(''));
  });

  it('stores an explicit hue and carries it onto the wire', () => {
    const { db, team } = seed();
    const { row } = addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 });
    expect(row.hue).toBe(212);
    expect(toMember(getMemberByName(db, team.id, 'miley')!, 'revive').hue).toBe(212);
  });

  it('refuses an explicit hue that collides, naming the neighbour', () => {
    const { db, team } = seed();
    addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
    expect(() => addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 })).toThrow(
      /hue 212 .*"ryder" \(214\)/,
    );
  });

  it('stores null when told null — the file said nothing, and the daemon does not invent', () => {
    const { db, team } = seed();
    const { row } = addMember(db, team, { name: 'dolly', kind: 'agent', hue: null });
    expect(row.hue).toBeNull();
  });

  it('a departed member does not hold its hue against the living', () => {
    const { db, team } = seed();
    const { row } = addMember(db, team, { name: 'ghost', kind: 'agent', hue: 100 });
    leaveMember(db, row.id);
    expect(addMember(db, team, { name: 'kimi', kind: 'agent', hue: 100 }).row.hue).toBe(100);
  });

  /* ADR 409: observers are sessions, not roster members. Live revive had nine web-* watchers
     holding hues against `team add`, so a file-backed explicit hue that was clear of every seat
     still 409'd. The uniqueness floor is observer = 0. */
  it('an observer does not hold its hue against a new seat', () => {
    const { db, team } = seed();
    addMember(db, team, { name: 'web-abc123', kind: 'human', observer: true, hue: 212 });
    expect(addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 }).row.hue).toBe(212);
  });

  it('a fresh seat still seeds from its name when an observer sits on that hue', () => {
    const { db, team } = seed();
    const seedHue = defaultHue('miley');
    addMember(db, team, { name: 'web-xyz', kind: 'human', observer: true, hue: seedHue });
    expect(addMember(db, team, { name: 'miley', kind: 'agent' }).row.hue).toBe(seedHue);
  });

  it('REVIVE on a DB-only team keeps the hue the seat had when the caller says nothing', () => {
    const { db, team } = seed();
    const { row } = addMember(db, team, { name: 'compo', kind: 'agent', hue: 77 });
    leaveMember(db, row.id);
    expect(addMember(db, team, { name: 'compo', kind: 'agent' }).row.hue).toBe(77);
  });

  /* Lane 01M2P43WQ7 — past a full wheel (the greedy walk seats a median 24 at 12°), an explicit hue
     that collides is KEPT and the neighbour is named on the way out, never a bare 409 with no hatch
     (ADR 145: degrade, never wedge). The 409 survives only while a clear hue exists — and then it
     names one, so it is a redirect rather than a dead end. */
  function fillTheWheel(db: ReturnType<typeof seed>['db'], team: ReturnType<typeof seed>['team']) {
    for (let i = 0; i < 40; i++) addMember(db, team, { name: `seat-${i}`, kind: 'agent' });
    expect(hueConflict(212, takenHues(db, team.id))).not.toBeNull();
  }

  it('past a full wheel an explicit colliding hue is kept, and the neighbour it shares with is named', () => {
    const { db, team } = seed();
    fillTheWheel(db, team);
    const { row, hue_shared_with } = addMember(db, team, {
      name: 'miley',
      kind: 'agent',
      hue: 212,
    });
    expect(row.hue).toBe(212);
    expect(hue_shared_with).toMatch(/^seat-\d+$/);
  });

  it('with clear hues left, an explicit collision is still refused — and the refusal names a clear hue', () => {
    const { db, team } = seed();
    addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
    let message = '';
    try {
      addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/"ryder" \(214\)/);
    const alt = Number(/(\d+) is clear/.exec(message)?.[1]);
    expect(Number.isInteger(alt)).toBe(true);
    expect(hueConflict(alt, takenHues(db, team.id))).toBeNull();
  });

  it("the seat file's word is never refused — a declared hue is stored even when it collides", () => {
    const { db, team } = seed();
    addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
    const { row, hue_shared_with } = addMember(db, team, {
      name: 'miley',
      kind: 'agent',
      hue: 212,
      hueDeclared: true,
    });
    expect(row.hue).toBe(212);
    expect(hue_shared_with).toBe('ryder');
  });

  it('setMemberHue follows the same rule: refused with an alternative while clear hues exist, kept past a full wheel', () => {
    const { db, team } = seed();
    addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
    const { row: miley } = addMember(db, team, { name: 'miley', kind: 'agent', hue: 40 });
    expect(() => setMemberHue(db, miley, 212)).toThrow(/is clear/);
    // A member's own hue is left out of its own way — so past a full wheel, re-asking for the
    // colour it already has is clear, and only a NEW colour meets the shared verdict.
    fillTheWheel(db, team);
    const { row: lin } = addMember(db, team, { name: 'lin', kind: 'agent', hue: 212 });
    expect(setMemberHue(db, lin, 214)).toBe('ryder');
    expect(getMemberByName(db, team.id, 'lin')!.hue).toBe(214);
  });
});
