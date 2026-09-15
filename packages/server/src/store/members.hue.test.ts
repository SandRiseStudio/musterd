import { HUE_MIN_SEPARATION, defaultHue, hueSeparation } from '@musterd/protocol/hue';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName, leaveMember } from './members.js';
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

  it('REVIVE on a DB-only team keeps the hue the seat had when the caller says nothing', () => {
    const { db, team } = seed();
    const { row } = addMember(db, team, { name: 'compo', kind: 'agent', hue: 77 });
    leaveMember(db, row.id);
    expect(addMember(db, team, { name: 'compo', kind: 'agent' }).row.hue).toBe(77);
  });
});
