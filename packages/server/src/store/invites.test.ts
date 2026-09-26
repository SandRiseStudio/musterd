import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  __setInviteKeyForTest,
  checkInvite,
  consumeInvite,
  formatRoomCode,
  listInvites,
  mintInvite,
  normalizeCode,
  parseInviteSecret,
  revokeInvite,
} from './invites.js';
import { createTeam } from './teams.js';

/** ADR 450 §1–3: mint / parse / verify / charge / burn, and the key-outside-the-DB posture. */
let db: ReturnType<typeof openDb>;
let teamId: string;
const KEY = randomBytes(32);

beforeEach(() => {
  __setInviteKeyForTest(KEY);
  db = openDb(':memory:');
  teamId = createTeam(db, { slug: 'dawn' }).id;
});
afterEach(() => {
  __setInviteKeyForTest(null);
  db.close();
});

describe('invites store', () => {
  it('mints a selector-prefixed link value and room code, and stores neither in plaintext', () => {
    const m = mintInvite(db, { teamId, createdBy: 'nick' });
    expect(m.link_secret).toMatch(/^[0-9A-Z]{3}\.[A-Za-z0-9_-]{27}$/);
    expect(m.room_code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(m.room_code.slice(0, 3)).toBe(m.invite.selector);
    const raw = db.prepare('SELECT * FROM team_invites WHERE id = ?').get(m.invite.id) as Record<
      string,
      unknown
    >;
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain(m.link_secret.split('.')[1]);
    expect(dump).not.toContain(m.room_code.replace(/-/g, '').slice(3));
    expect(m.invite.state).toBe('live');
    expect(m.invite).toMatchObject({ uses: 0, max_uses: 100, failures: 0, fail_budget: 20 });
  });

  it('accepts the link value and the typed code, in any case with separators and O/I/L confusables', () => {
    const m = mintInvite(db, { teamId, createdBy: 'nick' });
    expect(checkInvite(db, teamId, m.link_secret).ok).toBe(true);
    expect(checkInvite(db, teamId, ` ${m.link_secret} `).ok).toBe(true);
    const sloppy = m.room_code
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    const r = checkInvite(db, teamId, sloppy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe('code');
    expect(normalizeCode('ab-cd ol1i')).toBe('ABCD0111');
    expect(formatRoomCode('ABC', '12345678')).toBe('ABC-1234-5678');
  });

  it('charges only the invite the selector names, and never for an unknown selector or garbage', () => {
    const a = mintInvite(db, { teamId, createdBy: 'nick' });
    const b = mintInvite(db, { teamId, createdBy: 'nick' });
    const wrongA = `${a.invite.selector}-ZZZZ-ZZZZ`;
    const r = checkInvite(db, teamId, wrongA);
    expect(r).toMatchObject({ ok: false, selector: a.invite.selector, via: 'code', charged: true });
    const unknownSel = ['777', '778'].find(
      (s) => s !== a.invite.selector && s !== b.invite.selector,
    )!;
    expect(checkInvite(db, teamId, `${unknownSel}-ZZZZ-ZZZZ`)).toMatchObject({
      ok: false,
      charged: false,
    });
    expect(checkInvite(db, teamId, 'nope')).toEqual({
      ok: false,
      selector: null,
      via: null,
      charged: false,
    });
    const byId = Object.fromEntries(listInvites(db, teamId).map((i) => [i.id, i]));
    expect(byId[a.invite.id]!.failures).toBe(1);
    expect(byId[b.invite.id]!.failures).toBe(0);
  });

  it('burns at the failure budget, source-independent, and a burned invite refuses even the right code', () => {
    const m = mintInvite(db, { teamId, createdBy: 'nick', failBudget: 3 });
    for (let i = 0; i < 3; i++)
      expect(checkInvite(db, teamId, `${m.invite.selector}-AAAA-AAA${i}`).ok).toBe(false);
    expect(listInvites(db, teamId)[0]!.state).toBe('burned');
    expect(checkInvite(db, teamId, m.room_code).ok).toBe(false);
    expect(checkInvite(db, teamId, m.link_secret).ok).toBe(false);
    // Burning did not touch a sibling.
    const other = mintInvite(db, { teamId, createdBy: 'nick' });
    expect(checkInvite(db, teamId, other.room_code).ok).toBe(true);
    expect(checkInvite(db, teamId, other.link_secret).ok).toBe(true);
  });

  it('a right code costs nothing until consumed; uses cap at max_uses; expiry and revoke close it', () => {
    const now = Date.now();
    const m = mintInvite(
      db,
      { teamId, createdBy: 'nick', maxUses: 1, expiresAt: now + 60_000 },
      now,
    );
    const hit = checkInvite(db, teamId, m.room_code, now);
    expect(hit.ok).toBe(true);
    expect(listInvites(db, teamId, now)[0]!.uses).toBe(0);
    if (hit.ok) consumeInvite(db, hit.invite.id);
    expect(listInvites(db, teamId, now)[0]!.state).toBe('exhausted');
    expect(checkInvite(db, teamId, m.room_code, now).ok).toBe(false);

    const e = mintInvite(db, { teamId, createdBy: 'nick', expiresAt: now + 1000 }, now);
    expect(checkInvite(db, teamId, e.link_secret, now + 2000).ok).toBe(false);
    expect(listInvites(db, teamId, now + 2000).find((i) => i.id === e.invite.id)!.state).toBe(
      'expired',
    );

    const r = mintInvite(db, { teamId, createdBy: 'nick' });
    expect(revokeInvite(db, teamId, r.invite.id)).toBe(true);
    expect(revokeInvite(db, teamId, r.invite.id)).toBe(false);
    expect(checkInvite(db, teamId, r.link_secret).ok).toBe(false);
  });

  it('offline: a different HMAC key refuses the typed code but the link secret still admits', () => {
    const m = mintInvite(db, { teamId, createdBy: 'nick' });
    __setInviteKeyForTest(randomBytes(32));
    expect(checkInvite(db, teamId, m.room_code).ok).toBe(false);
    expect(checkInvite(db, teamId, m.link_secret).ok).toBe(true);
  });

  it('parseInviteSecret splits both spellings and rejects the rest', () => {
    expect(parseInviteSecret('abc.' + 'x'.repeat(27))).toEqual({
      selector: 'ABC',
      link: 'x'.repeat(27),
    });
    expect(parseInviteSecret('ABC-1234-5678')).toEqual({ selector: 'ABC', code: '12345678' });
    expect(parseInviteSecret('ABC-1234')).toBeNull();
    expect(parseInviteSecret('ab.short')).toBeNull();
  });

  it('validates mint inputs', () => {
    expect(() => mintInvite(db, { teamId, createdBy: 'n', maxUses: 0 })).toThrow(/max_uses/);
    expect(() => mintInvite(db, { teamId, createdBy: 'n', failBudget: 5000 })).toThrow(
      /fail_budget/,
    );
    expect(() => mintInvite(db, { teamId, createdBy: 'n', expiresAt: Date.now() - 1 })).toThrow(
      /expires_at/,
    );
    expect(() => mintInvite(db, { teamId, createdBy: 'n', memberUntil: Date.now() - 1 })).toThrow(
      /member_until/,
    );
  });
});
