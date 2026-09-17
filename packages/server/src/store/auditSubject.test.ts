import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { AUDIT_SUBJECT, appendAudit, appendAuditRequired, appendReplicatedEvent } from './audit.js';
import type { AuditAction } from './audit.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import { lastActionBySubject, quietestBusyMs } from './quiescence.js';
import { createTeam } from './teams.js';

/**
 * ADR 410 — every audit action declares whose row it is. The map answers ONE question, the one the
 * three generic readers ask: **which column holds the seat that acted**. `'none'` is the honest
 * answer for a machine-written row where no seat acted at all, and it is not the same as "no seat
 * is named" — `residency.woke` names a seat in `target`, and that seat did not act; the host
 * reported on it.
 */

const team = () => {
  const db = openDb(':memory:');
  const row = createTeam(db, { slug: 'revive' });
  return { db, team: row, teamId: row.id };
};

describe('AUDIT_SUBJECT (the declared map)', () => {
  it('declares every action this daemon writes — the ADR 410 falsifier, by grep', () => {
    // Falsifier 2: "an audit action reachable in packages/server/src with no AUDIT_SUBJECT entry".
    // Read from the source rather than the type, because the type is what a future writer widens
    // without thinking; this fails on the widening itself.
    // Read the source rather than the type: the type is what a future writer widens without
    // thinking, and this fails on the widening itself. `action:` covers a literal at a call site,
    // `action =` the handful hoisted into a ternary above one.
    const written = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          for (const m of readFileSync(full, 'utf8').matchAll(/\baction\s*[:=]\s*([^;,}]{0,200})/g))
            for (const q of m[1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) written.add(q[1]!);
        }
      }
    };
    // Resolve from this file, not cwd — the suite runs from the monorepo root too.
    walk(join(dirname(fileURLToPath(import.meta.url)), '..'));
    expect(written.size).toBeGreaterThan(50);
    const undeclared = [...written].filter((a) => AUDIT_SUBJECT[a as AuditAction] === undefined);
    expect(undeclared).toEqual([]);
  });

  it("puts interrupt.raised's subject in target — the row the sender never acted on", () => {
    // The whole live defect: the row is stamped when the RECIPIENT's probe fires, and `actor` is
    // the seat that sent the act, sometimes weeks earlier.
    expect(AUDIT_SUBJECT['interrupt.raised']).toBe('target');
    // Its sibling thirty lines away in the same handler is convention 1, and stays there.
    expect(AUDIT_SUBJECT['interrupt.refused']).toBe('actor');
  });

  it('answers "who acted", not "who is it about" — an admin op credits the admin', () => {
    // The two questions diverge exactly on convention 2. `grant.issue` is ABOUT the grantee and was
    // ACTED by the admin; crediting the grantee with work would be the same defect mirrored.
    expect(AUDIT_SUBJECT['grant.issue']).toBe('actor');
    expect(AUDIT_SUBJECT['member.remove']).toBe('actor');
  });

  it('says none for the machine-written rows, which credit nobody', () => {
    for (const a of [
      'residency.wake_leased',
      'residency.woke',
      'residency.wake_failed',
      'claim.pending',
      'request.expired',
    ] as const) {
      expect(AUDIT_SUBJECT[a]).toBe('none');
    }
  });
});

describe('appendAudit refuses an undeclared action (ADR 410 decision 2)', () => {
  const undeclared = 'totally.invented' as AuditAction;
  const entry = { actor: 'ada', action: undeclared, target: null, result: 'allow' } as const;

  it('throws from the plain append — the load-bearing half, or the map rots', () => {
    const { db, teamId } = team();
    expect(() => appendAudit(db, teamId, entry)).toThrow(/AUDIT_SUBJECT/);
  });

  it('throws from the two sibling writers too — all three insert the same columns', () => {
    const { db, teamId } = team();
    expect(() => appendAuditRequired(db, teamId, entry)).toThrow(/AUDIT_SUBJECT/);
    expect(() => appendReplicatedEvent(db, teamId, entry)).toThrow(/AUDIT_SUBJECT/);
  });

  it('still swallows a STORAGE failure — the refusal is about the map, not the row', () => {
    const { db, teamId } = team();
    db.prepare('DROP TABLE audit').run();
    expect(() =>
      appendAudit(db, teamId, {
        actor: 'ada',
        action: 'inbox.rendered',
        target: 'ada',
        result: 'allow',
      }),
    ).not.toThrow();
  });
});

describe('the three generic readers consult the map (ADR 410 decision 3)', () => {
  const NOW = 10_000_000;

  /** A team with two live agent seats and one `interrupt.raised` row: sender ada, recipient lin. */
  const withRaise = () => {
    const { db, team: row, teamId } = team();
    const ada = addMember(db, row, { name: 'ada', kind: 'agent' }).row;
    const lin = addMember(db, row, { name: 'lin', kind: 'agent' }).row;
    attach(db, ada.id, 'claude-code', 'c1');
    attach(db, lin.id, 'claude-code', 'c2');
    // Written when LIN's probe fired; `actor` is the seat that sent the act, possibly weeks ago.
    appendAudit(db, teamId, {
      actor: 'ada',
      action: 'interrupt.raised',
      target: 'lin',
      result: 'allow',
    });
    return { db, teamId, ada, lin };
  };

  it('credits the probing recipient, not the sender — the live defect, closed', () => {
    const { db, teamId } = withRaise();
    const seen = lastActionBySubject(db, teamId, { now: NOW });
    expect(seen.has('lin')).toBe(true);
    expect(seen.has('ada')).toBe(false);
  });

  it('drops a machine-written row entirely — nobody is credited for a wake', () => {
    const { db, team: row, teamId } = team();
    addMember(db, row, { name: 'ada', kind: 'agent' });
    appendAudit(db, teamId, {
      actor: null,
      action: 'residency.woke',
      target: 'ada',
      result: 'allow',
    });
    expect(lastActionBySubject(db, teamId, { now: NOW }).has('ada')).toBe(false);
  });

  it('still credits the actor on a convention-3 row — the counterparty is not the worker', () => {
    const { db, team: row, teamId } = team();
    addMember(db, row, { name: 'ada', kind: 'agent' });
    addMember(db, row, { name: 'lin', kind: 'agent' });
    appendAudit(db, teamId, {
      actor: 'ada',
      action: 'send.denied',
      target: 'lin',
      result: 'deny',
    });
    const seen = lastActionBySubject(db, teamId, { now: NOW });
    expect(seen.has('ada')).toBe(true);
    expect(seen.has('lin')).toBe(false);
  });

  it("quietestBusyMs joins members on the subject, so /health's bounce reads the recipient", () => {
    const { db } = withRaise();
    // Sender-keyed, this row would have said "someone acted just now" about ada. It still says
    // somebody is busy — but the seat it means is lin, and a lin-less team is silent.
    expect(quietestBusyMs(db, { presenceTimeoutMs: 60_000 })).not.toBeNull();
    const { db: db2, team: row2, teamId: t2 } = team();
    const solo = addMember(db2, row2, { name: 'ada', kind: 'agent' }).row;
    attach(db2, solo.id, 'claude-code', 'c1');
    appendAudit(db2, t2, {
      actor: 'ada',
      action: 'interrupt.raised',
      target: 'gone',
      result: 'allow',
    });
    expect(quietestBusyMs(db2, { presenceTimeoutMs: 60_000 })).toBeNull();
  });

  it('leaves the excludeActions list doing its own job — a different axis', () => {
    // The map says WHICH COLUMN; the list says WHICH ACTIONS ARE WORK. A claim is convention 1 and
    // still excluded from review selection, because establishing authority is not being busy.
    const { db, team: row, teamId } = team();
    addMember(db, row, { name: 'ada', kind: 'agent' });
    appendAudit(db, teamId, {
      actor: 'ada',
      action: 'claim.occupied',
      target: 'ada',
      result: 'allow',
    });
    expect(lastActionBySubject(db, teamId, { now: NOW }).has('ada')).toBe(true);
    expect(
      lastActionBySubject(db, teamId, { now: NOW, excludeActions: ['claim.occupied'] }).has('ada'),
    ).toBe(false);
  });
});
