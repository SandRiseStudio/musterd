import { describe, expect, it } from 'vitest';
import { actOn, type ActDeps } from './act.js';
import { DEFAULT_TIERS } from './classify.js';
import {
  RAISE_WINDOW_MS,
  emptyStamp,
  raiseReason,
  recordAttempt,
  recordRaise,
  recordSuppressed,
  type GuardianStamp,
} from './damp.js';

const NOW = 5_000_000;

interface Captured {
  service: string[][];
  notify: string[];
  asks: string[];
  audits: Array<{ action: string }>;
}

function deps(stamp: GuardianStamp, over: Partial<ActDeps> = {}): { d: ActDeps; got: Captured } {
  const got: Captured = { service: [], notify: [], asks: [], audits: [] };
  const d: ActDeps = {
    now: () => NOW,
    stamp,
    tiers: DEFAULT_TIERS,
    runService: async (args) => {
      got.service.push(args);
      return { ok: true };
    },
    osNotify: (n) => {
      got.notify.push(n.title);
    },
    sendAsk: async (body) => {
      got.asks.push(body);
    },
    audit: async (action) => {
      got.audits.push({ action });
    },
    log: () => {},
    ...over,
  };
  return { d, got };
}

describe('actOn (spec §4–§5)', () => {
  it('publisher_failed at auto with attempt allowed runs refresh --live and audits remediated', async () => {
    const { d, got } = deps(emptyStamp());
    const report = await actOn([{ class: 'publisher_failed' }], d);
    expect(got.service).toEqual([['refresh', '--live']]);
    expect(got.audits.map((a) => a.action)).toContain('guardian.remediated');
    expect(got.notify).toEqual([]);
    expect(report.stamp.lastAttemptAt.publisher_failed).toBe(NOW);
  });

  it('publisher_failed with attempt refused by damping escalates to alert instead', async () => {
    const stamp = recordAttempt(emptyStamp(), 'publisher_failed', NOW - 60_000);
    const { d, got } = deps(stamp);
    await actOn([{ class: 'publisher_failed' }], d);
    expect(got.service).toEqual([]);
    expect(got.notify.length).toBe(1);
    expect(got.asks.length).toBe(1);
    expect(got.audits.map((a) => a.action)).toContain('guardian.escalated');
  });

  it('crashloop at auto rolls back to lastGoodBuild AND alerts (acts and tells)', async () => {
    const stamp = { ...emptyStamp(), lastGoodBuild: 'abc1234' };
    const { d, got } = deps(stamp);
    await actOn([{ class: 'crashloop' }], d);
    expect(got.service).toEqual([['refresh', '--pin', 'abc1234', '--force']]);
    expect(got.notify.length).toBe(1);
    expect(got.asks.length).toBe(1);
    expect(got.audits.map((a) => a.action)).toContain('guardian.remediated');
  });

  it('crashloop with no known-good build cannot roll back — alert only', async () => {
    const { d, got } = deps(emptyStamp());
    await actOn([{ class: 'crashloop' }], d);
    expect(got.service).toEqual([]);
    expect(got.notify.length).toBe(1);
    expect(got.audits.map((a) => a.action)).toContain('guardian.alerted');
  });

  it('alert-tier classes notify + ask + audit alerted; observe audits only', async () => {
    const { d, got } = deps(emptyStamp(), {
      tiers: { ...DEFAULT_TIERS, presence_churn: 'observe' },
    });
    await actOn([{ class: 'daemon_down' }, { class: 'presence_churn' }], d);
    expect(got.notify.length).toBe(1);
    expect(got.asks.length).toBe(1);
    expect(got.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['guardian.alerted', 'guardian.observed']),
    );
  });

  it('audit failure never breaks the tick — the daemon may be the thing that is down', async () => {
    const { d, got } = deps(emptyStamp(), {
      audit: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(actOn([{ class: 'daemon_down' }], d)).resolves.toBeTruthy();
    expect(got.notify.length).toBe(1);
  });
});

/**
 * The last link. Evidence that classify gathered is worthless if the raise body drops it — which is
 * the whole failure being fixed: 22 raises, one distinct body, nothing to adjudicate.
 */
describe('the raise carries the incident evidence', () => {
  it('appends evidence to the alert body', async () => {
    const { d, got } = deps(emptyStamp());
    await actOn(
      [{ class: 'daemon_down', evidence: '/health did not answer in 3 attempts (timed out)' }],
      d,
    );
    const body = got.asks.join('\n');
    expect(body).toContain('daemon_down');
    expect(body).toContain('3 attempts');
    expect(body).toContain('timed out');
  });

  it('an incident with no evidence still reads exactly as before — no dangling separator', async () => {
    const { d, got } = deps(emptyStamp());
    await actOn([{ class: 'presence_churn' }], d);
    expect(got.asks.join('\n')).toContain('guardian: presence_churn — needs a human');
    expect(got.asks.join('\n')).not.toContain('—  ');
  });
});

/**
 * Raise damping at the action layer. The alert tier had no damper at all: `shouldAttempt` was
 * consulted only inside the `tier === 'auto' && remedy !== null` branch, so an alert class — which
 * `daemon_down` ships as — raised on every tick that classified it. Five byte-identical asks
 * landed in 33 minutes on 2026-08-21; nothing counted them as a series.
 */
describe('an alert-tier raise is damped and its repeats are counted', () => {
  /** The real 2026-08-21 raise body, verbatim from messages (339 chars, 5 identical copies). */
  const EVIDENCE =
    '/health did not answer in 3 attempts (The operation was aborted due to timeout), but launchd ' +
    'reports a clean exit and 15 run(s) — the process was never restarted, so it may still be ' +
    'running and merely too slow to answer. Check /health directly and compare booted_at before ' +
    'treating this as an outage.';
  /** The 2026-08-20 body — same class, different probe error and run count. */
  const OTHER_EVIDENCE =
    '/health did not answer in 3 attempts (fetch failed), but launchd reports a clean exit and 1 ' +
    'run(s) — the process was never restarted, so it may still be running and merely too slow to ' +
    'answer. Check /health directly and compare booted_at before treating this as an outage.';

  /** The five real firing times, 12:18:10 → 12:51:14 local. */
  const CLUSTER = [0, 149_000, 292_000, 1_425_000, 1_984_000];

  it('the 2026-08-21 cluster raises ONCE, not five times', async () => {
    let stamp = emptyStamp();
    const asks: string[] = [];
    const audits: string[] = [];
    for (const offset of CLUSTER) {
      const { d } = deps(stamp, {
        now: () => NOW + offset,
        sendAsk: async (b) => {
          asks.push(b);
        },
        audit: async (a) => {
          audits.push(a);
        },
      });
      stamp = (await actOn([{ class: 'daemon_down', evidence: EVIDENCE }], d)).stamp;
    }
    expect(asks.length).toBe(1);
    expect(audits.filter((a) => a === 'guardian.alerted').length).toBe(1);
    expect(audits.filter((a) => a === 'guardian.suppressed').length).toBe(4);
    expect(stamp.lastRaise.daemon_down?.suppressed).toBe(4);
  });

  it('a suppressed raise stays silent on the OS too — no notification, no ask', async () => {
    const stamp = recordRaise(
      emptyStamp(),
      'daemon_down',
      raiseReason('daemon_down', 'needs a human', EVIDENCE),
      NOW,
    );
    const { d, got } = deps(stamp);
    await actOn([{ class: 'daemon_down', evidence: EVIDENCE }], d);
    expect(got.asks).toEqual([]);
    expect(got.notify).toEqual([]);
    expect(got.audits.map((a) => a.action)).toEqual(['guardian.suppressed']);
  });

  it('a changed probe error is new information and raises immediately', async () => {
    const stamp = recordRaise(
      emptyStamp(),
      'daemon_down',
      raiseReason('daemon_down', 'needs a human', EVIDENCE),
      NOW,
    );
    const { d, got } = deps(stamp, { now: () => NOW + 1000 });
    await actOn([{ class: 'daemon_down', evidence: OTHER_EVIDENCE }], d);
    expect(got.asks.length).toBe(1);
    expect(got.asks[0]).toContain('fetch failed');
  });

  it('the hourly re-raise carries the suppressed count, so the series is readable', async () => {
    let stamp = recordRaise(
      emptyStamp(),
      'daemon_down',
      raiseReason('daemon_down', 'needs a human', EVIDENCE),
      NOW,
    );
    stamp = recordSuppressed(stamp, 'daemon_down', NOW + 60_000);
    stamp = recordSuppressed(stamp, 'daemon_down', NOW + 120_000);
    const { d, got } = deps(stamp, { now: () => NOW + RAISE_WINDOW_MS });
    await actOn([{ class: 'daemon_down', evidence: EVIDENCE }], d);
    expect(got.asks.length).toBe(1);
    expect(got.asks[0]).toContain('2 identical raises suppressed');
    // A persisting outage is still audible — the count is the point, not the silence.
    expect(got.asks[0]).toContain(EVIDENCE);
  });

  it('the escalation raise is damped too — an undamped escalation is the same unbounded ask', async () => {
    let stamp = recordAttempt(emptyStamp(), 'publisher_failed', NOW - 60_000);
    const asks: string[] = [];
    for (const offset of [0, 60_000, 120_000]) {
      const { d } = deps(stamp, {
        now: () => NOW + offset,
        sendAsk: async (b) => {
          asks.push(b);
        },
      });
      stamp = (await actOn([{ class: 'publisher_failed' }], d)).stamp;
    }
    expect(asks.length).toBe(1);
  });

  it('suppression never swallows a distinct class raised in the same tick', async () => {
    const stamp = recordRaise(
      emptyStamp(),
      'daemon_down',
      raiseReason('daemon_down', 'needs a human', EVIDENCE),
      NOW,
    );
    const { d, got } = deps(stamp, { now: () => NOW + 1000 });
    await actOn([{ class: 'daemon_down', evidence: EVIDENCE }, { class: 'wrong_db' }], d);
    expect(got.asks.length).toBe(1);
    expect(got.asks[0]).toContain('wrong_db');
  });
});

describe('the install control probe is exempt from raise damping', () => {
  it('fires every time and touches no raise memory — a dry run cannot silence the next dry run', async () => {
    let stamp = emptyStamp();
    const asks: string[] = [];
    for (const offset of [0, 1000, 2000]) {
      const { d } = deps(stamp, {
        now: () => NOW + offset,
        dampRaises: false,
        sendAsk: async (b) => {
          asks.push(b);
        },
      });
      stamp = (await actOn([{ class: 'daemon_down', evidence: 'same every time' }], d)).stamp;
    }
    expect(asks.length).toBe(3);
    expect(stamp.lastRaise).toEqual({});
  });
});
