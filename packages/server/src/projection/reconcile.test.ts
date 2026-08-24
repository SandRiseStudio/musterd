import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERALIST_CAPABILITIES, parseSeatFile, parseTeamFile } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/open.js';
import {
  getMemberByName,
  isHeld,
  listMembers,
  markBound,
  setMemberGovernance,
} from '../store/members.js';
import { listRoleNames, roleSummariesMap } from '../store/roles.js';
import { toMember } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { loadTeamSpec } from './load.js';
import { reconcileAll, reconcileTeam } from './reconcile.js';
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

  it('projects Team and Member working hours, preserving the Member override', () => {
    writeRoster(
      `slug = "alpha"

[working_hours]
timezone = "America/Los_Angeles"
days = ["mon", "tue", "wed", "thu", "fri"]
start = "11:00"
end = "15:00"
`,
      {
        inherited: 'kind = "agent"\n',
        custom: `kind = "agent"

[working_hours]
timezone = "America/New_York"
days = ["mon", "wed", "fri"]
start = "09:00"
end = "12:00"
`,
      },
    );
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(team.working_hours).toBe(
      JSON.stringify({
        timezone: 'America/Los_Angeles',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '11:00',
        end: '15:00',
      }),
    );
    expect(getMemberByName(db, team.id, 'inherited')?.working_hours).toBeNull();
    expect(getMemberByName(db, team.id, 'custom')?.working_hours).toBe(
      JSON.stringify({
        timezone: 'America/New_York',
        days: ['mon', 'wed', 'fri'],
        start: '09:00',
        end: '12:00',
      }),
    );
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

// Guard 1 above only proves files → db → files: it seeds from files that never had capabilities, so
// the round trip is faithful by construction. `team export` runs the OTHER direction — a LIVE db
// whose capabilities were written by paths that have no file (the ADR 071 creator-admin grant is
// written straight to the member row at team create). Nothing guarded that direction, and the
// projection dropped capabilities entirely: exporting revive's roster on 2026-08-01 rebuilt its only
// admin as a plain generalist, leaving the team with ZERO admins, silently and unrecoverably through
// the API (every admin-gated route was then closed to everyone).
describe('reconcile — guard 1b: a LIVE db round-trips through files without losing authority', () => {
  it('projects per-seat capabilities so db → files → db is a fixed point', () => {
    writeRole(
      'lead',
      'charter = "x"\n\n[capabilities]\nis_admin = true\nvisibility_level = "admin"\n',
    );
    writeRoster('slug = "alpha"\n', {
      boss: 'kind = "human"\nrole = "lead"\n',
      quiet: 'kind = "agent"\nrole = ""\n',
    });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;

    // A narrowing written straight to the row, as governance ops do — no file says this.
    const quiet = getMemberByName(db, team.id, 'quiet')!;
    setMemberGovernance(
      db,
      quiet.id,
      null,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, can_message: 'none' }),
    );

    // Export: project the LIVE db back to files, then reconcile those files into a fresh db.
    const { seatFiles, teamToml } = serializeProjectedTeam(projectTeamToFiles(db, 'alpha')!);
    writeRoster(teamToml, {
      boss: seatFiles['boss.toml']!,
      quiet: seatFiles['quiet.toml']!,
    });
    reconcile();

    // Authority survives the round trip — this is the bug: it used to come back is_admin false.
    const bossAfter = toMember(getMemberByName(db, team.id, 'boss')!);
    expect(bossAfter.capabilities.is_admin).toBe(true);
    expect(bossAfter.capabilities.visibility_level).toBe('admin');
    // …and so does a per-seat narrowing that no role expresses.
    const quietAfter = toMember(getMemberByName(db, team.id, 'quiet')!);
    expect(quietAfter.capabilities.can_message).toBe('none');
  });

  it('reports a seat whose capabilities no role can express, instead of dropping them', () => {
    writeRoster('slug = "alpha"\n', { solo: 'kind = "human"\nrole = ""\n' });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    const solo = getMemberByName(db, team.id, 'solo')!;
    // Admin with no admin ROLE: unrepresentable, because a seat override can only narrow. This is
    // exactly revive's creator — the shape that got silently downgraded.
    setMemberGovernance(
      db,
      solo.id,
      null,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
    );

    const projected = projectTeamToFiles(db, 'alpha')!;
    expect(projected.unrepresentable).toHaveLength(1);
    expect(projected.unrepresentable[0]).toContain('solo');
    expect(projected.unrepresentable[0]).toMatch(/is_admin/);
  });
});

describe('reconcile — a projection must not silently leave a team with no admin', () => {
  it('errors when the roster would strip the last admin', () => {
    writeRole('lead', 'charter = "x"\n\n[capabilities]\nis_admin = true\n');
    writeRoster('slug = "alpha"\n', { boss: 'kind = "human"\nrole = "lead"\n' });
    expect(reconcile().errors).toHaveLength(0); // healthy: one admin

    // The roster is rewritten with the role dropped — the exact shape `team export` produced.
    writeRoster('slug = "alpha"\n', { boss: 'kind = "human"\nrole = ""\n' });
    const r = reconcile();
    expect(r.errors.some((e) => /no admin/i.test(e))).toBe(true);
  });

  it('stays quiet for a team that never had an admin — this reports a LOSS, not a lint', () => {
    writeRoster('slug = "beta"\n', { hand: 'kind = "agent"\nrole = ""\n' });
    expect(reconcile().errors).toHaveLength(0);
    expect(reconcile().errors).toHaveLength(0); // and stays quiet on re-reconcile
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

describe('reconcile — unknown keys warn, never fail (nick 2026-08-21)', () => {
  it('warns about a key no schema knows, and still projects the seat', () => {
    // The live instance: seats/autorefresh.toml carries an authored `charter`, which is in
    // RoleFileSchema but not SeatFileSchema. Reconcile has silently dropped it since 2026-08-05.
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
    });
    const r = reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    // WARN, not fail — the seat still lands. Failing would refuse autorefresh's seat on the live
    // roster today, which is why this is a warning and nick decided it explicitly.
    expect(listMembers(db, team.id).map((m) => m.name)).toEqual(['olive']);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      'seats/olive.toml: dropped unknown key(s) charter — not in the schema, so reconcile ignores them',
    ]);
  });

  it('warns on team.toml and roles/*.toml too — every durable class, not just seats', () => {
    writeRoster('slug = "alpha"\nnot_a_team_key = "x"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n',
    });
    writeRole('platform', 'summary = "P"\ncharter = "C"\nnot_a_role_key = "y"\n');
    const r = reconcile();
    expect(r.warnings).toEqual([
      'team.toml: dropped unknown key(s) not_a_team_key — not in the schema, so reconcile ignores them',
      'roles/platform.toml: dropped unknown key(s) not_a_role_key — not in the schema, so reconcile ignores them',
    ]);
  });

  it('a clean roster warns about nothing', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    expect(reconcile().warnings).toEqual([]);
  });
});

describe('reconcile — canonical drift is reported, because nothing else reads it', () => {
  /**
   * `musterd fmt --check` has existed since ADR 058 and NOTHING RUNS IT. Measured 2026-08-24: two
   * role files on the live roster drifted from 2026-08-04 until a human happened to check by hand,
   * twenty days later. CI cannot cover it — the roster is not in this repo — so the reader has to be
   * the one process that already opens every roster file on every pass.
   */
  it('reports a file whose bytes are not what the serializer would write', () => {
    // The exact live shape, inverted: a flush table header is now the non-canonical one (ADR 309).
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    writeRole('platform', 'summary = "P"\n[capabilities]\nis_admin = false\n');
    const r = reconcile();
    expect(r.drift).toEqual(['roles/platform.toml']);
  });

  it('still projects the drifted entry — cosmetic drift is never fail-closed', () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\n[capabilities]\ncan_message = "none"\n',
    });
    const r = reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(listMembers(db, team.id).map((m) => m.name)).toEqual(['olive']);
    expect(r.errors).toEqual([]);
    expect(r.drift).toEqual(['seats/olive.toml']);
  });

  it('keeps drift separate from a dropped key — they mean different things', () => {
    // ADR 304's own lesson: a reader must be able to tell data loss from tidiness. An unknown key
    // ALSO makes the bytes non-canonical, so this file is both — and says so twice, distinctly.
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
    });
    const r = reconcile();
    expect(r.drift).toEqual(['seats/olive.toml']);
    expect(r.warnings).toEqual([
      'seats/olive.toml: dropped unknown key(s) charter — not in the schema, so reconcile ignores them',
    ]);
  });

  it('a canonical roster reports no drift — including the hand-authored blank-line shape', () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    writeRole('platform', 'summary = "P"\n\n[capabilities]\nis_admin = false\n');
    const r = reconcile();
    expect(r.drift).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('reconcileAll surfaces what a pass found (nothing did until 2026-08-21)', () => {
  it('logs canonical drift as its own line, distinct from a dropped key', async () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    writeRole('platform', 'summary = "P"\n[capabilities]\nis_admin = false\n');
    const { log } = await import('../log.js');
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
      seen.push(f as Record<string, unknown>);
    });
    try {
      reconcileAll(db, [dir]);
    } finally {
      spy.mockRestore();
    }
    const drifted = seen.find((f) => f['msg'] === 'reconcile_file_drifted');
    expect(drifted).toBeDefined();
    expect(String(drifted?.['detail'])).toContain('roles/platform.toml');
    expect(drifted?.['team']).toBe('alpha');
    // The instrument must not borrow ADR 304's channel — that would re-merge the two meanings.
    expect(seen.map((f) => f['msg'])).not.toContain('reconcile_key_dropped');
  });

  it('logs BOTH a skipped entry and a dropped key — collected-and-discarded was the old behaviour', async () => {
    writeRoster('slug = "alpha"\n', {
      olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
      broken: 'this is not = valid toml = at all\n',
    });
    const { log } = await import('../log.js');
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
      seen.push(f as Record<string, unknown>);
    });
    try {
      reconcileAll(db, [dir]);
    } finally {
      spy.mockRestore();
    }
    const kinds = seen.map((f) => f['msg']);
    // The skipped seat — load.ts calls this "never silently dropped", and until now it was.
    expect(kinds).toContain('reconcile_entry_error');
    // The dropped field — the case the promise never covered at all.
    expect(kinds).toContain('reconcile_key_dropped');
    const dropped = seen.find((f) => f['msg'] === 'reconcile_key_dropped');
    expect(String(dropped?.['detail'])).toContain('charter');
    expect(dropped?.['team']).toBe('alpha');
  });

  it('says nothing about a clean roster', async () => {
    writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
    const { log } = await import('../log.js');
    const seen: string[] = [];
    const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
      seen.push(String((f as Record<string, unknown>)['msg']));
    });
    try {
      reconcileAll(db, [dir]);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([]);
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
    // A HUMAN seat: an admin role projects fully onto a human (agents get is_admin clamped below).
    writeRoster('slug = "alpha"\n', { olive: 'kind = "human"\nrole = "reviewer"\n' });
    reconcile();
    const caps = memberView('olive').capabilities!;
    expect(caps.can_flag_urgent).toBe(false);
    expect(caps.visibility_level).toBe('admin');
    expect(caps.is_admin).toBe(true);
    expect(caps.can_observe).toBe(true); // unset role field falls back to generalist
  });

  it('clamps is_admin on an AGENT seat, loudly — admins can only be humans (ADR 172)', () => {
    // This exact shape used to project cleanly: an agent handed an admin role read is_admin=true,
    // so a seat file could quietly manufacture the authority every admin gate exists to check
    // (governance ops, audit reads, risky-lane human review). Now the single writer clamps it and
    // says so; every other capability of the role still projects.
    writeRole('ops', '[capabilities]\ncan_flag_urgent = false\nis_admin = true\n');
    writeRoster('slug = "alpha"\n', { botty: 'kind = "agent"\nrole = "ops"\n' });
    const result = reconcile();
    const caps = memberView('botty').capabilities!;
    expect(caps.is_admin).toBe(false);
    expect(caps.can_flag_urgent).toBe(false); // the rest of the role projects untouched
    expect(result.errors.some((e) => e.includes('botty') && e.includes('human-only'))).toBe(true);
  });

  it('clamps is_admin on a SERVICE seat exactly as on an agent (ADR 232 / ADR 172)', () => {
    // The service kind must not inherit a softer gate by being new: a cron declaring an admin role
    // is the same manufactured authority, one identity further from a keyboard.
    writeRole('ops', '[capabilities]\nis_admin = true\n');
    writeRoster('slug = "alpha"\n', { autorefresh: 'kind = "service"\nrole = "ops"\n' });
    const result = reconcile();
    expect(memberView('autorefresh').kind).toBe('service');
    expect(memberView('autorefresh').capabilities!.is_admin).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('autorefresh') && e.includes('a service') && e.includes('human-only'),
      ),
    ).toBe(true);
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

  it('projects a multi-role seat: roles[] on the member, capabilities merged restrictively (ADR 227)', () => {
    writeRole('designer', 'summary = "Owns the design surfaces"\n');
    writeRole('observer', '[capabilities]\ncan_flag_urgent = false\ncan_message = "none"\n');
    writeRoster('slug = "alpha"\n', {
      miley: 'kind = "agent"\nrole = "designer"\nroles = ["designer", "observer"]\n',
    });
    reconcile();
    const m = memberView('miley');
    expect(m.roles).toEqual(['designer', 'observer']);
    expect(m.role).toBe('designer'); // display label = first entry
    // the observer role's explicit restrictions hold across the pair
    expect(m.capabilities!.can_message).toBe('none');
    expect(m.capabilities!.can_flag_urgent).toBe(false);
  });

  it('warns on an unknown role name in the roles array without dropping the seat (ADR 227 roster truth)', () => {
    writeRoster('slug = "alpha"\n', {
      izzo: 'kind = "agent"\nrole = "platfrom"\nroles = ["platfrom"]\n', // typo'd, no roles/platfrom.toml
    });
    const r = reconcile();
    expect(r.errors.some((e) => e.includes('izzo') && e.includes('platfrom'))).toBe(true);
    // the seat itself is projected — a typo is a warning, not an outage
    expect(memberView('izzo').capabilities).toEqual(GENERALIST_CAPABILITIES);
  });

  it('a legacy bare role label stays unvalidated (back-compat — "tester" is a label, not drift)', () => {
    writeRoster('slug = "alpha"\n', { tinybot: 'kind = "agent"\nrole = "tester"\n' });
    const r = reconcile();
    expect(r.errors).toEqual([]);
    expect(memberView('tinybot').roles).toEqual(['tester']);
  });

  it('a roleless seat stays the generalist and warns nothing (roles are optional)', () => {
    writeRoster('slug = "alpha"\n', { dolly: 'kind = "agent"\nrole = ""\n' });
    const r = reconcile();
    expect(r.errors).toEqual([]);
    const m = memberView('dolly');
    expect(m.roles).toEqual([]);
    expect(m.capabilities).toEqual(GENERALIST_CAPABILITIES);
  });

  it('projects the role summary into the roles table (ADR 227)', () => {
    writeRole('designer', 'summary = "Owns the design surfaces"\ncharter = "The standing rule."\n');
    writeRoster('slug = "alpha"\n', { miley: 'kind = "agent"\nrole = "designer"\n' });
    reconcile();
    const team = getTeamBySlug(db, 'alpha')!;
    expect(roleSummariesMap(db, team.id).get('designer')).toBe('Owns the design surfaces');
  });

  it('an agent reaching admin through ANY held role is clamped, multi-role included (ADR 172)', () => {
    writeRole('admin', '[capabilities]\nis_admin = true\n');
    writeRole('designer', 'summary = "Owns the design surfaces"\n');
    writeRoster('slug = "alpha"\n', {
      sneaky: 'kind = "agent"\nrole = "designer"\nroles = ["designer", "admin"]\n',
    });
    const r = reconcile();
    expect(memberView('sneaky').capabilities!.is_admin).toBe(false);
    expect(r.errors.some((e) => e.includes('sneaky'))).toBe(true);
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
