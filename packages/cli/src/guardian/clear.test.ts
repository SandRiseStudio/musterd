import { describe, expect, it } from 'vitest';
import { dischargeCleared, type DischargeDeps } from './act.js';
import { emptyStamp, raiseReason, recordRaise, type GuardianStamp } from './damp.js';
import type { GuardianClass } from './classify.js';

const NOW = 9_000_000;

/**
 * ADR 432 — a guardian incident ask is discharged by its CONDITION CLEARING, not by a human.
 *
 * Guardian is a `service` seat, and ADR 232 bars a service seat from the peer verbs by design: it
 * never accepts. So it can RAISE an obligation and cannot DISCHARGE one, including its own. Every
 * incident it reports is therefore owed forever unless a human answers, and nobody does — by the
 * time anyone looks the daemon is back up and there is visibly nothing to answer. Measured on the
 * hub daemon 2026-09-21: 55 guardian `ask`/`request_help` acts with no accept/decline, 30 from
 * August, and ADR 429's obligation rule now pins every one of them into every bounded inbox read.
 *
 * The signal was always there and was never spoken: `classify` returns the incidents, so a class
 * ABSENT from a tick is a class this guardian has just observed healthy. These tests are about
 * saying so.
 *
 * The direction this must never err in is the second test. A raise that is silently cleared while
 * the condition persists is strictly worse than the 55 stale asks — it is the one real outage going
 * quiet. Every other test here is about noise; that one is about safety.
 */
interface Audit {
  action: string;
  detail: Record<string, unknown>;
}

function deps(stamp: GuardianStamp, over: Partial<DischargeDeps> = {}) {
  const audits: Audit[] = [];
  const resolves: Array<{ thread: string; body: string }> = [];
  const d: DischargeDeps = {
    stamp,
    audit: async (action, detail) => {
      audits.push({ action, detail });
    },
    sendResolve: async (thread, body) => {
      resolves.push({ thread, body });
    },
    log: () => {},
    ...over,
  };
  return { d, audits, resolves };
}

/** The classes firing this tick — what the caller owes `dischargeCleared`. */
const firing = (...cls: GuardianClass[]): ReadonlySet<GuardianClass> => new Set(cls);

/** A stamp carrying an open, already-raised alert for `daemon_down` — the shape on disk today. */
function withOpenRaise(
  cls: 'daemon_down' | 'daemon_wedged' = 'daemon_down',
  actId: string | null = `act-${cls}`,
): GuardianStamp {
  return recordRaise(emptyStamp(), cls, raiseReason(cls, 'needs a human'), NOW - 600_000, actId);
}

describe('ADR 432: a cleared condition discharges its own raise', () => {
  it('a healthy tick clears a class that had an open raise, and says so in the ledger', async () => {
    const { d, audits } = deps(withOpenRaise());
    const stamp = await dischargeCleared(firing(), d);

    const cleared = audits.filter((a) => a.action === 'guardian.cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.detail['class']).toBe('daemon_down');
    // The memo is gone, so a later recurrence raises fresh rather than being damped against a
    // reason nobody is still owed.
    expect(stamp.lastRaise['daemon_down']).toBeUndefined();
  });

  it('DOES NOT clear a class whose incident is still present — the one direction this must not err', async () => {
    const { d, audits } = deps(withOpenRaise());
    const stamp = await dischargeCleared(firing('daemon_down'), d);

    expect(audits.filter((a) => a.action === 'guardian.cleared')).toHaveLength(0);
    expect(stamp.lastRaise['daemon_down']).toBeDefined();
  });

  it('clears only the class that recovered when two were open', async () => {
    let s = withOpenRaise('daemon_down');
    s = recordRaise(
      s,
      'daemon_wedged',
      raiseReason('daemon_wedged', 'needs a human'),
      NOW - 600_000,
    );
    const { d, audits } = deps(s);
    const stamp = await dischargeCleared(firing('daemon_wedged'), d);

    const cleared = audits.filter((a) => a.action === 'guardian.cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.detail['class']).toBe('daemon_down');
    expect(stamp.lastRaise['daemon_down']).toBeUndefined();
    expect(stamp.lastRaise['daemon_wedged']).toBeDefined();
  });

  it('says nothing when there was no open raise — a quiet guardian stays quiet', async () => {
    const { d, audits } = deps(emptyStamp());
    await dischargeCleared(firing(), d);
    expect(audits.filter((a) => a.action === 'guardian.cleared')).toHaveLength(0);
  });

  it('closes the raise with a RESOLVE on its own thread, never an accept', async () => {
    // ADR 232 bars a service seat from the peer verbs, so `accept` is not available to guardian.
    // `resolve` is thread-terminal (ADR 025) and is not a peer verb — it is the discharge guardian
    // can actually express, and the one the server's pinned fold now honours.
    const { d, resolves } = deps(withOpenRaise());
    await dischargeCleared(firing(), d);
    expect(resolves).toEqual([
      { thread: 'act-daemon_down', body: 'guardian: daemon_down — cleared; this raise is closed' },
    ]);
    // No new ask, structurally: `DischargeDeps` has no `sendAsk` to reach for. A recovery must
    // not bill anyone's attention the way the incident did, and now it cannot.
  });

  it('keeps the memo when the resolve fails to send — an un-sent discharge is not a discharge', async () => {
    // The failure that would otherwise strand a pinned obligation with nothing left that knows to
    // close it: guardian forgets locally, the team never hears, and the ask is owed forever.
    const { d, resolves } = deps(withOpenRaise(), {
      sendResolve: async () => {
        throw new Error('daemon unreachable — it may BE the incident');
      },
    });
    const stamp = await dischargeCleared(firing(), d);
    expect(resolves).toHaveLength(0);
    expect(stamp.lastRaise['daemon_down']).toBeDefined();
  });

  it('still forgets a raise it has no thread for, rather than pinning the memo forever', async () => {
    // A raise from before ADR 432, or one whose send reported no id. There is nothing to resolve,
    // so the ask stays owed on the server — but the local memo must not wedge the damper shut.
    const { d, resolves } = deps(withOpenRaise('daemon_down', null));
    const stamp = await dischargeCleared(firing(), d);
    expect(resolves).toHaveLength(0);
    expect(stamp.lastRaise['daemon_down']).toBeUndefined();
  });

  it('carries the raise it is discharging, so the ledger row can be matched to the ask', async () => {
    const { d, audits } = deps(withOpenRaise());
    await dischargeCleared(firing(), d);
    const cleared = audits.find((a) => a.action === 'guardian.cleared')!;
    expect(cleared.detail['raised_at']).toBe(NOW - 600_000);
  });
});
