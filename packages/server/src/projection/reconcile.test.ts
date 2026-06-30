import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERALIST_CAPABILITIES, parseSeatFile, parseTeamFile } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { getMemberByName, isHeld, listMembers, markBound } from '../store/members.js';
import { listRoleNames } from '../store/roles.js';
import { toMember } from '../store/rows.js';
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

function writeRole(name: string, body: string): void {
  const rolesDir = join(dir, '.musterd', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, `${name}.toml`), body);
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
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    const before = getMemberByName(db, team.id, 'olive')!;
    // Hold the seat (first occupancy stamps bound_at; ADR 058).
    markBound(db, before.id);
    const held = getMemberByName(db, team.id, 'olive')!;
    expect(isHeld(held)).toBe(true);

    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "approver"\n' });
    const r = reconcile();
    expect(r.updated).toEqual(['olive']);
    const after = getMemberByName(db, team.id, 'olive')!;
    expect(after.id).toBe(before.id); // id preserved → message log continuity
    expect(after.token_hash).toBe(before.token_hash); // token_hash preserved → reconcile UPDATEs in place
    expect(after.bound_at).toBe(held.bound_at); // still held
    expect(after.role).toBe('approver');
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
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    const firstSeat = getMemberByName(db, team.id, 'olive')!;
    const firstId = firstSeat.id;
    const firstHash = firstSeat.token_hash;
    markBound(db, firstId); // hold it

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
    // Deletion = revocation: the seat got a fresh token_hash (the old one is gone).
    expect(revived.token_hash).not.toBe(firstHash);
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

describe('reconcile — governance projection (ADR 070, v0.3 P1)', () => {
  function memberView(name: string) {
    const team = getTeamBySlug(db, 'alpha')!;
    const row = getMemberByName(db, team.id, name)!;
    return toMember(row, 'alpha');
  }

  it('a seat with no role gets the generalist default + derived provisioned status', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = ""\n' });
    reconcile();
    const m = memberView('olive');
    expect(m.capabilities).toEqual(GENERALIST_CAPABILITIES);
    expect(m.account_status).toBe('provisioned'); // never held
  });

  it('derives active once the seat has been held (authenticated)', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = ""\n' });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    markBound(db, getMemberByName(db, team.id, 'olive')!.id); // first occupancy stamps bound_at (ADR 058)
    expect(memberView('olive').account_status).toBe('active');
  });

  it("projects a role's default capabilities onto its seat", () => {
    writeRole(
      'reviewer',
      '[capabilities]\ncan_flag_urgent = false\nvisibility_level = "admin"\nis_admin = true\n',
    );
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    reconcile();
    const caps = memberView('olive').capabilities!;
    expect(caps.can_flag_urgent).toBe(false);
    expect(caps.visibility_level).toBe('admin');
    expect(caps.is_admin).toBe(true);
    expect(caps.can_observe).toBe(true); // unset role field falls back to generalist
  });

  it('a per-seat override narrows the role default but cannot widen it', () => {
    writeRole('reviewer', '[capabilities]\ncan_flag_urgent = true\n');
    writeRoster('slug = "alpha"\n', {
      // narrows urgent off, and tries to self-promote is_admin (role default false) → clamped
      olive:
        'kind = "agent"\nrole = "reviewer"\n[capabilities]\ncan_flag_urgent = false\nis_admin = true\n',
    });
    reconcile();
    const caps = memberView('olive').capabilities!;
    expect(caps.can_flag_urgent).toBe(false); // narrowed
    expect(caps.is_admin).toBe(false); // widening clamped
  });

  it('honours an admin-set account_status override from the file', () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = ""\naccount_status = "banned"\n',
    });
    reconcile();
    expect(memberView('olive').account_status).toBe('banned');
  });

  it('drops a role from the projection when its file is removed', () => {
    writeRole('reviewer', '[capabilities]\ncan_flag_urgent = false\n');
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    reconcile();
    expect(memberView('olive').capabilities!.can_flag_urgent).toBe(false);

    // remove the role file → seat falls back to generalist on the next reconcile
    rmSync(join(dir, '.musterd', 'roles', 'reviewer.toml'));
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(listRoleNames(db, team.id)).toEqual([]);
    expect(memberView('olive').capabilities!.can_flag_urgent).toBe(true); // generalist again
  });
});
