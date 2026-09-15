import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { wokenBadge, wokenSeat } from './wokenSeat';

/**
 * A woken seat says so — the read half of "a woken agent is invisible on /live".
 *
 * The lane's measured diagnosis was four-part; this file covers the one part that is a pure read of
 * a fact the wire ALREADY carries. `PresenceSchema` has stamped `provenance` since musterd/0.2
 * (protocol/src/member.ts:64) and the roster ships it unfiltered (`SELECT p.*` at
 * store/presence.ts:461, attached at transport/http.ts:1427). The web has been parsing it into
 * memory and ignoring it: the only `provenance` in `packages/web/src/live` is the literal
 * `'session'` the client sends for ITSELF (client.ts:610). So a wake has been indistinguishable
 * from a human opening a terminal, using data that was already in the browser.
 *
 * Two rules bound what this may claim, and both are load-bearing:
 *
 *   • **ADR 236 — absence is not an assertion.** A row with no `provenance` is a row that did not
 *     say, not a row that said "not a wake". Pre-0.2 sessions and every older client land there.
 *     So the badge fires on the stamped value alone and never on the absence of another.
 *   • **posture.ts:7 — clients render the wire token, they do not invent synonyms.** `woken` is
 *     therefore NOT a fifth posture. It rides ALONGSIDE `working`/`active`/`away`/`offline` as a
 *     separate fact, because it answers a different question: posture is what the seat is doing,
 *     provenance is why it is here at all.
 */

const seat = (presences: unknown[] = []): MemberSummary =>
  ({
    id: 'm_gptbot',
    name: 'gptbot',
    kind: 'agent',
    presence: 'online',
    posture: 'active',
    presences,
    capabilities: {},
  }) as unknown as MemberSummary;

const p = (over: Record<string, unknown> = {}) =>
  ({ status: 'online', surface: 'codex', provenance: null, last_seen_at: Date.now(), ...over }) as never;

describe('wokenSeat — was this seat spawned by a wake?', () => {
  it('is true when the live presence was stamped by a wake', () => {
    expect(wokenSeat(seat([p({ provenance: 'wake' })]))).toBe(true);
  });

  it('is false for a seat someone opened themselves', () => {
    expect(wokenSeat(seat([p({ provenance: 'session' })]))).toBe(false);
  });

  /**
   * The whole point of ADR 236 in one test. A pre-0.2 row, or any client that never stamped, is
   * SILENT — and silence must not be promoted into either answer. It reads false because false is
   * "we are not claiming a wake", not because we concluded there wasn't one.
   */
  it('is false when the row never said — absence is not an assertion', () => {
    expect(wokenSeat(seat([p({ provenance: null })]))).toBe(false);
    expect(wokenSeat(seat([p({})]))).toBe(false);
  });

  it('is false for a seat with no presence at all', () => {
    expect(wokenSeat(seat([]))).toBe(false);
  });

  /**
   * The scene already picks the online/away row rather than index 0 (OfficeScene.tsx:37), because a
   * seat can hold a stale offline row in front of its live one. The badge must read the SAME row
   * the rest of the nameplate reads, or the plate would say `codex` and `woken` about two different
   * sessions.
   */
  it('reads the live row, not merely the first', () => {
    const m = seat([
      p({ status: 'offline', provenance: 'session', surface: 'cli' }),
      p({ status: 'online', provenance: 'wake', surface: 'codex' }),
    ]);
    expect(wokenSeat(m)).toBe(true);
  });

  it('ignores the other stamped provenances — only a wake is a wake', () => {
    for (const provenance of ['asked', 'hook', 'scheduled', 'daemon']) {
      expect(wokenSeat(seat([p({ provenance })]))).toBe(false);
    }
  });
});

describe('wokenBadge — what the surfaces are allowed to say', () => {
  it('names the fact plainly and does not guess who sent it', () => {
    expect(wokenBadge().label).toBe('woken');
  });

  /**
   * The lane's candidate (a) asked for "woken by &lt;sender&gt;". That half is NOT buildable from the
   * web: the sender lives on the `residency.wake_leased` audit row, and `GET /teams/:slug/audit` is
   * `authAdmin` (transport/http.ts:1954) while /live viewers hold ordinary member auth. The
   * presence carries `wake_lease`, but a lease id is not a name and resolving it needs the audit.
   * So the badge says what it knows. The title says why it stops there, rather than leaving the
   * next reader to rediscover the gate.
   */
  it('says in its own tooltip that the sender is not knowable here', () => {
    expect(wokenBadge().title).toMatch(/wake/i);
    expect(wokenBadge().title).toMatch(/sender|who|audit/i);
  });
});
