import { describe, expect, test } from 'vitest';
import { DWELL_WINDOW_MS, dwellTrace, observeSeats, type DwellLog } from './dwell';

const T0 = 1_700_000_000_000;

/** The minimal seat shape the dwell log reads. */
function seat(name: string, presence: 'online' | 'away' | 'offline', last_seen_at?: number) {
  return { name, presence, last_seen_at: last_seen_at ?? null };
}

describe('observeSeats', () => {
  test('records NO arrival for a seat already online in the first read — that beginning was not watched', () => {
    const log = observeSeats({}, [seat('gptbot', 'online')], T0);
    expect(log.gptbot).toEqual({ lastOnlineAt: T0 });
  });

  test('records the arrival of a seat this page first read absent', () => {
    let log = observeSeats({}, [seat('gptbot', 'offline')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 3_000);
    expect(log.gptbot).toEqual({ arrivedAt: T0 + 3_000, lastOnlineAt: T0 + 3_000 });
  });

  test('a seat first read offline is remembered as absent, with no visit to it', () => {
    const log = observeSeats({}, [seat('gptbot', 'offline')], T0);
    expect(log.gptbot).toEqual({ departed: true });
  });

  test('keeps the original arrival across later reads while the seat stays online', () => {
    const absent = observeSeats({}, [seat('gptbot', 'offline')], T0);
    const first = observeSeats(absent, [seat('gptbot', 'online')], T0);
    const later = observeSeats(first, [seat('gptbot', 'online')], T0 + 8_000);
    expect(later.gptbot).toEqual({ arrivedAt: T0, lastOnlineAt: T0 + 8_000 });
  });

  test('a seat that comes back after departing starts a NEW visit', () => {
    const visit1 = observeSeats({}, [seat('gptbot', 'online')], T0);
    const gone = observeSeats(visit1, [seat('gptbot', 'offline')], T0 + 11_000);
    const visit2 = observeSeats(gone, [seat('gptbot', 'online')], T0 + 500_000);
    expect(visit2.gptbot).toEqual({ arrivedAt: T0 + 500_000, lastOnlineAt: T0 + 500_000 });
  });

  test('a seat that flickers back within the window still starts a NEW visit — the trace reports contiguous presence only', () => {
    let log = observeSeats({}, [seat('gptbot', 'online')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 10_000);
    log = observeSeats(log, [seat('gptbot', 'offline')], T0 + 12_000);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 20_000);
    expect(log.gptbot).toEqual({ arrivedAt: T0 + 20_000, lastOnlineAt: T0 + 20_000 });
  });

  test('a departed seat keeps its record past the window — the trace expires on age, and the log is bounded by the roster', () => {
    const visit = observeSeats({}, [seat('gptbot', 'online')], T0);
    const stale = observeSeats(visit, [seat('gptbot', 'offline')], T0 + DWELL_WINDOW_MS + 1);
    expect(stale.gptbot).toEqual({ lastOnlineAt: T0, departed: true });
    expect(dwellTrace(stale, seat('gptbot', 'offline'), T0 + DWELL_WINDOW_MS + 1)).toBeNull();
    // Bounded: only names in the read survive the fold, so the log can never outgrow the team.
    expect(Object.keys(observeSeats(stale, [], T0 + DWELL_WINDOW_MS + 2))).toEqual([]);
  });
});

describe('dwellTrace', () => {
  test('a seat that is still here gets no trace — the room already shows it', () => {
    const log = observeSeats({}, [seat('gptbot', 'online')], T0);
    expect(dwellTrace(log, seat('gptbot', 'online'), T0 + 5_000)).toBeNull();
  });

  test('an away seat gets no trace either — away is presence, not departure', () => {
    const log = observeSeats({}, [seat('gptbot', 'online')], T0);
    expect(dwellTrace(log, seat('gptbot', 'away'), T0 + 5_000)).toBeNull();
  });

  test('a seat that left says how long ago, in the past tense', () => {
    let log = observeSeats({}, [seat('gptbot', 'online')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 11_000);
    const trace = dwellTrace(log, seat('gptbot', 'offline'), T0 + 11_000 + 9_000);
    expect(trace?.label).toBe('was here · left 9s ago');
  });

  test('names the visit length only when this page watched the seat arrive', () => {
    let log = observeSeats({}, [seat('gptbot', 'offline')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 11_000);
    const trace = dwellTrace(log, seat('gptbot', 'offline'), T0 + 12_000);
    expect(trace?.title).toContain('11s');
  });

  test('never states a duration for a seat that was already online when the page loaded', () => {
    // Arrival unobserved: the log carries lastOnlineAt but no arrivedAt.
    const log: DwellLog = { gptbot: { lastOnlineAt: T0 } };
    const trace = dwellTrace(log, seat('gptbot', 'offline'), T0 + 4_000);
    expect(trace?.label).toBe('was here · left 4s ago');
    expect(trace?.title).not.toMatch(/\d+s here/);
  });

  test('the trace expires, so a seat that left long ago is simply offline', () => {
    const log = observeSeats({}, [seat('gptbot', 'online')], T0);
    expect(dwellTrace(log, seat('gptbot', 'offline'), T0 + DWELL_WINDOW_MS + 1)).toBeNull();
  });

  test('a seat with no observed visit at all gets no trace', () => {
    expect(dwellTrace({}, seat('gptbot', 'offline'), T0)).toBeNull();
  });
});

describe('the arrival this page did not witness (gptbot, lane 01M1JQENBK)', () => {
  test('a seat already online in the first roster read gets no arrival, so its trace claims no duration', () => {
    // The page opens onto a room that already has gptbot in it. Nothing here was witnessed
    // beginning: eight seconds later it leaves, and the only honest thing to say is that it was
    // here and when it went.
    let log = observeSeats({}, [seat('gptbot', 'online')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 8_000);
    log = observeSeats(log, [seat('gptbot', 'offline')], T0 + 8_000);
    expect(log.gptbot?.arrivedAt).toBeUndefined();
    const trace = dwellTrace(log, seat('gptbot', 'offline'), T0 + 9_000);
    expect(trace?.label).toBe('was here · left 1s ago');
    expect(trace?.title).not.toMatch(/\d+s/);
    expect(trace?.title).not.toContain('Watched from this page');
  });

  test('a seat read offline and then online HAS a witnessed arrival — that is the wake this rail exists for', () => {
    let log = observeSeats({}, [seat('gptbot', 'offline')], T0);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 5_000);
    log = observeSeats(log, [seat('gptbot', 'online')], T0 + 16_000);
    log = observeSeats(log, [seat('gptbot', 'offline')], T0 + 17_000);
    expect(log.gptbot?.arrivedAt).toBe(T0 + 5_000);
    expect(dwellTrace(log, seat('gptbot', 'offline'), T0 + 18_000)?.title).toContain('11s');
  });

  test('a seat only ever read offline gets no trace at all', () => {
    const log = observeSeats({}, [seat('gptbot', 'offline')], T0);
    expect(dwellTrace(log, seat('gptbot', 'offline'), T0 + 1_000)).toBeNull();
  });
});
