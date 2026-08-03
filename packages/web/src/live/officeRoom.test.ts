import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { officeRoom, type OfficeRoomProps } from './officeRoom';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('officeRoom', () => {
  it('carries every room fact through', () => {
    const stream = {
      teamWorkingHours: { timezone: 'America/Los_Angeles', days: ['mon'], start: '11:00', end: '15:00' },
      roster: [{ name: 'miley' }],
      envelopes: [{ id: 'e1' }],
      liveIds: new Set(['miley']),
      status: 'live',
    } as unknown as Parameters<typeof officeRoom>[1];
    const entries = [{ name: 'miley' }] as unknown as OfficeRoomProps['entries'];
    const board = { lanes: [] } as unknown as OfficeRoomProps['board'];

    const room = officeRoom('revive', stream, { entries, board });
    expect(room).toEqual({
      teamName: 'revive',
      teamWorkingHours: stream.teamWorkingHours,
      roster: stream.roster,
      envelopes: stream.envelopes,
      liveIds: stream.liveIds,
      entries,
      board,
      status: stream.status,
    });
  });
});

/**
 * The parity guard. `/live` and `/broadcast` typecheck independently, so a room fact wired on one and
 * forgotten on the other is invisible to every other test — that is exactly how the working-hours
 * calendar reached the page and never reached the stream. Both routes must build the room from
 * `officeRoom` and spread it, never assemble it prop by prop, because the spread is what makes a new
 * fact arrive on both surfaces at once.
 */
/**
 * `<OfficeScene …/>`'s own attributes, with nested elements skipped — `/live` seats an `<AsksStrip/>`
 * in `topSlot`, and its props are not the room's.
 */
function officeSceneAttrs(text: string): string {
  const start = text.indexOf('<OfficeScene');
  if (start < 0) return '';
  let depth = 0;
  let out = '';
  for (let i = start + 1; i < text.length; i++) {
    if (text.startsWith('/>', i)) {
      if (depth === 0) return out;
      depth--;
      i++;
      continue;
    }
    if (text[i] === '<' && /[A-Za-z]/.test(text[i + 1] ?? '')) depth++;
    else if (depth === 0) out += text[i]; // only OfficeScene's own attribute text
  }
  return '';
}

describe('/live and /broadcast frame the same room', () => {
  const routes = {
    live: src('../routes/live.tsx'),
    broadcast: src('../routes/broadcast.tsx'),
  };

  for (const [name, text] of Object.entries(routes)) {
    it(`${name} spreads the shared room into OfficeScene`, () => {
      const call = officeSceneAttrs(text);
      expect(call, `${name} renders OfficeScene`).not.toBe('');
      expect(call).toContain('{...officeRoom(');
    });

    it(`${name} passes no room fact as its own prop`, () => {
      const call = officeSceneAttrs(text);
      // Every key of OfficeRoomProps, named so this list cannot fall behind the type.
      const roomKeys: (keyof OfficeRoomProps)[] = [
        'teamName',
        'teamWorkingHours',
        'roster',
        'envelopes',
        'liveIds',
        'entries',
        'board',
        'status',
      ];
      const leaked = roomKeys.filter((k) => new RegExp(`\\b${k}=\\{`).test(call));
      expect(leaked, `${name} should take these from officeRoom, not pass them itself`).toEqual([]);
    });
  }
});
