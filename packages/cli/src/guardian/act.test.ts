import { describe, expect, it } from 'vitest';
import { actOn, type ActDeps } from './act.js';
import { DEFAULT_TIERS } from './classify.js';
import { emptyStamp, recordAttempt, type GuardianStamp } from './damp.js';

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
