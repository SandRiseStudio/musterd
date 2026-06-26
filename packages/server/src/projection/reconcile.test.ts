import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSeatFile, parseTeamFile } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { authMember, getMemberByName, isHeld, listMembers } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { loadTeamSpec } from './load.js';
import { reconcileTeam } from './reconcile.js';
import { projectTeamToFiles, serializeProjectedTeam } from './serialize.js';

let dir: string;
let db: Database;

function writeRoster(team: string, seats: Record<string, string>): void {
  const m = join(dir, '.musterd');
  mkdirSync(join(m, 'seats'), { recursive: true });
  writeFileSync(join(m, 'team.toml'), team);
  for (const [name, body] of Object.entries(seats)) {
    writeFileSync(join(m, 'seats', `${name}.toml`), body);
  }
}

function reconcile() {
  const spec = loadTeamSpec(dir);
  if (!spec) throw new Error('no spec');
  return reconcileTeam(db, spec);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-roster-'));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcile — match-by-name delta', () => {
  it('ADDs new seats and mints a token for each', () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
      david: 'kind = "human"\nrole = "lead"\n',
    });
    const r = reconcile();
    expect(r.added.sort()).toEqual(['david', 'olive']);
    expect(Object.keys(r.minted).sort()).toEqual(['david', 'olive']);
    const team = getTeamBySlug(db, 'alpha')!;
    expect(
      listMembers(db, team.id)
        .map((m) => m.name)
        .sort(),
    ).toEqual(['david', 'olive']);
  });

  it('is idempotent — a second pass changes nothing and mints nothing', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    reconcile();
    const r2 = reconcile();
    expect(r2.added).toEqual([]);
    expect(r2.updated).toEqual([]);
    expect(r2.minted).toEqual({});
  });

  it('UPDATEs a role in place, preserving id + token_hash + bound_at', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    const minted = reconcile().minted['olive']!;
    const team = getTeamBySlug(db, 'alpha')!;
    const before = getMemberByName(db, team.id, 'olive')!;
    // Hold the seat (first auth touch sets bound_at).
    authMember(db, 'alpha', minted);
    const held = getMemberByName(db, team.id, 'olive')!;
    expect(isHeld(held)).toBe(true);

    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "approver"\n' });
    const r = reconcile();
    expect(r.updated).toEqual(['olive']);
    const after = getMemberByName(db, team.id, 'olive')!;
    expect(after.id).toBe(before.id); // id preserved → message log continuity
    expect(after.token_hash).toBe(before.token_hash); // token preserved → live session unaffected
    expect(after.bound_at).toBe(held.bound_at); // still held
    expect(after.role).toBe('approver');
    // The held token still authenticates after the update.
    expect(() => authMember(db, 'alpha', minted)).not.toThrow();
  });

  it('REMOVEs a seat whose file is deleted via soft-tombstone (left_at), never hard-delete', () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
      david: 'kind = "human"\nrole = "lead"\n',
    });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    const oliveId = getMemberByName(db, team.id, 'olive')!.id;

    writeRoster('slug = "alpha"\n', { david: 'kind = "human"\nrole = "lead"\n' });
    rmSync(join(dir, '.musterd', 'seats', 'olive.toml'));
    const r = reconcile();
    expect(r.removed).toEqual(['olive']);
    // Soft-tombstoned: row persists (FK + history) but is excluded from the live roster.
    expect(listMembers(db, team.id).map((m) => m.name)).toEqual(['david']);
    expect(getMemberByName(db, team.id, 'olive')!.id).toBe(oliveId);
    expect(getMemberByName(db, team.id, 'olive')!.left_at).not.toBeNull();
  });

  it('REVIVEs a re-added seat with the same id but a fresh token (deletion = revocation)', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    const firstToken = reconcile().minted['olive']!;
    const team = getTeamBySlug(db, 'alpha')!;
    const firstId = getMemberByName(db, team.id, 'olive')!.id;
    authMember(db, 'alpha', firstToken); // hold it

    // Delete then re-add the seat.
    rmSync(join(dir, '.musterd', 'seats', 'olive.toml'));
    reconcile(); // tombstone
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    const r = reconcile();

    expect(r.revived).toEqual(['olive']);
    const revived = getMemberByName(db, team.id, 'olive')!;
    expect(revived.id).toBe(firstId); // same identity → log continuity
    expect(revived.left_at).toBeNull();
    expect(isHeld(revived)).toBe(false); // back to declared
    // The old token is revoked; the new one works.
    expect(() => authMember(db, 'alpha', firstToken)).toThrow();
    expect(() => authMember(db, 'alpha', r.minted['olive']!)).not.toThrow();
  });

  it('resolves an omitted seat lifecycle from the team default', () => {
    writeRoster('slug = "alpha"\nlifecycle = "session"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
    });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(getMemberByName(db, team.id, 'olive')!.lifecycle).toBe('session');
  });
});

describe('reconcile — guard 1: db projection round-trips to the files', () => {
  it('projectTeamToFiles → serialize → parse deep-equals the on-disk spec', () => {
    writeRoster('slug = "alpha"\ndisplay = "Team Alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
      temp: 'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
    });
    reconcile();

    const projected = projectTeamToFiles(db, 'alpha')!;
    const { teamToml, seatFiles } = serializeProjectedTeam(projected);

    // Parsed structure of the *serialized projection* equals the parsed structure of the live files.
    expect(parseTeamFile(teamToml)).toEqual(
      parseTeamFile('slug = "alpha"\ndisplay = "Team Alpha"\n'),
    );
    expect(parseSeatFile(seatFiles['olive.toml']!, 'olive')).toEqual(
      parseSeatFile('kind = "agent"\nrole = "reviewer"\n', 'olive'),
    );
    expect(parseSeatFile(seatFiles['temp.toml']!, 'temp')).toEqual(
      parseSeatFile(
        'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
        'temp',
      ),
    );
  });
});

describe('reconcile — fail-closed: a corrupt seat is skipped, siblings intact', () => {
  it('keeps good seats and records the bad one in errors', () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
      broken: 'this is not = valid toml = at all\n',
    });
    const r = reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(listMembers(db, team.id).map((m) => m.name)).toEqual(['olive']);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('broken.toml');
  });
});
