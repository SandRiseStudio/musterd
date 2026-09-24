import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import {
  DoorbellPolicySchema,
  DoorbellPrefsSchema,
  DoorbellRecordSchema,
  doorbellPrefsProblem,
  holdsRing,
  maskPrefs,
  actMayRing,
  publicHttpsUrlProblem,
  resolveRoute,
  ringTargets,
} from './doorbell.js';
import { FEATURE_EPOCH } from './feature-epoch.js';

const humans = new Set(['nick', 'ana']);
const admins = new Set(['nick']);
const ring = (act: string, to: string | null, meta: Record<string, unknown> = {}) =>
  ringTargets({ act, to, meta, humans, admins });

describe('actMayRing', () => {
  it('is true exactly for the acts ringTargets can ring', () => {
    for (const act of ['ask', 'request_help', 'handoff']) expect(actMayRing(act)).toBe(true);
    for (const act of ['message', 'status_update', 'accept', 'resolve'])
      expect(actMayRing(act)).toBe(false);
  });
});

describe('what rings the doorbell (ADR 443)', () => {
  it('a directed ask rings its human', () => expect(ring('ask', 'ana')).toEqual(['ana']));
  it('a team-addressed ask rings every admin human, never every human', () =>
    expect(ring('ask', null)).toEqual(['nick']));
  it('an ask directed to an agent rings the admin humans (ADR 147 routing)', () =>
    expect(ring('ask', 'dolly')).toEqual(['nick']));
  it.each(['request_help', 'handoff'])('a directed %s to a human rings', (act) =>
    expect(ring(act, 'ana')).toEqual(['ana']),
  );
  it('a directed lane_review ask to a human rings', () =>
    expect(ring('ask', 'ana', { lane_review: { lane: 'L1' } })).toEqual(['ana']));
  it('a lane_review ask to an agent does not ring anyone', () =>
    expect(ring('ask', 'big-body', { lane_review: { lane: 'L1' } })).toEqual([]));
  it('a team-addressed lane_review ask does not ring', () =>
    expect(ring('ask', null, { lane_review: { lane: 'L1' } })).toEqual([]));
  it.each(['request_help', 'handoff'])('a team-addressed %s does not ring', (act) =>
    expect(ring(act, null)).toEqual([]),
  );
  it('a directed handoff to an agent does not ring', () =>
    expect(ring('handoff', 'dolly')).toEqual([]));
  it.each(['message', 'status_update', 'steer', 'insight', 'accept', 'resolve'])(
    '%s never rings',
    (act) => expect(ring(act, 'ana')).toEqual([]),
  );
  it('a team with no admin human: a team-addressed ask rings nobody', () =>
    expect(ringTargets({ act: 'ask', to: null, meta: {}, humans, admins: new Set() })).toEqual([]));
});

describe('the record', () => {
  const rec = {
    team: 'revive',
    from: 'dolly',
    act: 'ask',
    act_id: '01X',
    answer_path: '/live?act=01X',
  };
  it('parses the structured fields', () =>
    expect(DoorbellRecordSchema.parse({ ...rec, tier: 'blocking', species: 'approve' })).toEqual({
      ...rec,
      tier: 'blocking',
      species: 'approve',
    }));
  it('has no body field, and rejects one', () => {
    expect(DoorbellRecordSchema.parse(rec)).not.toHaveProperty('body');
    expect(() => DoorbellRecordSchema.parse({ ...rec, body: 'secret' })).toThrow();
  });
});

describe('routing', () => {
  const policy = DoorbellPolicySchema.parse({
    allow: ['live', 'os', 'slack'],
    defaults: ['live', 'slack'],
  });
  const prefs = (sinks: Record<string, unknown>) => DoorbellPrefsSchema.parse({ sinks });

  it('an empty policy allows every sink and defaults to live + os', () => {
    const p = DoorbellPolicySchema.parse({});
    expect(p.allow).toEqual(['live', 'os', 'slack', 'webhook']);
    expect(resolveRoute(p, undefined, 'standard')).toEqual(['live', 'os']);
  });
  it('defaults apply when the human set nothing', () =>
    expect(resolveRoute(policy, undefined, 'standard')).toEqual(['live', 'slack']));
  it('a human override stays inside the allow-list', () =>
    expect(
      resolveRoute(
        policy,
        prefs({
          os: { on: true },
          slack: { on: false },
          webhook: { on: true, url: 'https://x.io' },
        }),
        'standard',
      ),
    ).toEqual(['live', 'os']));
  it('live cannot be switched off', () =>
    expect(resolveRoute(policy, prefs({ live: { on: false } }), 'standard')).toContain('live'));
  it('a per-tier rule narrows a sink', () => {
    const p = prefs({ slack: { on: true, tiers: ['blocking'] } });
    expect(resolveRoute(policy, p, 'standard')).not.toContain('slack');
    expect(resolveRoute(policy, p, 'blocking')).toContain('slack');
  });
  it('an act with no tier passes a per-tier rule', () =>
    expect(
      resolveRoute(policy, prefs({ slack: { on: true, tiers: ['blocking'] } }), undefined),
    ).toContain('slack'));
});

describe('holds (ADR 443 §4)', () => {
  const now = 1_000_000;
  it('available never holds', () =>
    expect(holdsRing({ status: 'available' }, 'standard', now)).toBe(false));
  it('no availability never holds', () => expect(holdsRing(null, 'standard', now)).toBe(false));
  it.each(['away', 'dnd'] as const)('%s holds a standard ring', (status) =>
    expect(holdsRing({ status }, 'standard', now)).toBe(true),
  );
  it('off_hours does not hold (no schedule enforcement in v1)', () =>
    expect(holdsRing({ status: 'off_hours' }, 'standard', now)).toBe(false));
  it('blocking pierces dnd', () =>
    expect(holdsRing({ status: 'dnd' }, 'blocking', now)).toBe(false));
  it('blocking does not pierce away', () =>
    expect(holdsRing({ status: 'away' }, 'blocking', now)).toBe(true));
  it('a lapsed until does not hold', () =>
    expect(holdsRing({ status: 'dnd', until: now - 1 }, 'standard', now)).toBe(false));
  it('a future until holds', () =>
    expect(holdsRing({ status: 'dnd', until: now + 1 }, 'standard', now)).toBe(true));
});

describe('sink URLs must be https to a public host', () => {
  it.each(['https://hooks.slack.com/services/T/B/X', 'https://ntfy.sh/topic', 'https://8.8.8.8/x'])(
    '%s is accepted',
    (url) => expect(publicHttpsUrlProblem(url)).toBeNull(),
  );
  it.each([
    ['http://hooks.slack.com/x', 'https'],
    ['https://localhost/x', 'private'],
    ['https://localhost./x', 'private'],
    ['https://printer.local./x', 'private'],
    ['https://foo.localhost/x', 'private'],
    ['https://127.0.0.1/x', 'private'],
    ['https://[::1]/x', 'private'],
    ['https://169.254.169.254/latest', 'private'],
    ['https://10.0.0.5/x', 'private'],
    ['https://172.16.0.1/x', 'private'],
    ['https://172.31.255.1/x', 'private'],
    ['https://192.168.1.10/x', 'private'],
    ['https://0.0.0.0/x', 'private'],
    ['https://[fd00::1]/x', 'private'],
    ['https://[fe80::1]/x', 'private'],
    ['https://[::ffff:127.0.0.1]/x', 'private'],
    ['https://printer.local/x', 'private'],
    ['not a url', 'url'],
  ])('%s is rejected (%s)', (url, kind) => expect(publicHttpsUrlProblem(url)).toMatch(kind));
  it('172.32.x is public', () => expect(publicHttpsUrlProblem('https://172.32.0.1/')).toBeNull());
  it('the problem never echoes the URL', () =>
    expect(publicHttpsUrlProblem('https://10.0.0.5/secret-token')).not.toMatch(/secret|10\.0/));
});

describe('personal URLs stay private (ADR 443 §5)', () => {
  const prefs = DoorbellPrefsSchema.parse({
    sinks: {
      webhook: { on: true, url: 'https://ntfy.sh/nick-secret-topic' },
      os: { on: true, host: 'mac-a' },
      slack: { on: false, tiers: ['blocking'] },
    },
  });
  it('maskPrefs says a personal URL exists, never what it is', () => {
    const masked = maskPrefs(prefs);
    expect(masked).toEqual({
      os: { on: true, host: 'mac-a', personal: false },
      slack: { on: false, tiers: ['blocking'], personal: false },
      webhook: { on: true, personal: true },
    });
    expect(JSON.stringify(masked)).not.toMatch(/ntfy|secret|url/);
  });
  it('maskPrefs of nothing is empty', () => expect(maskPrefs(undefined)).toEqual({}));

  const all = ['live', 'os', 'slack', 'webhook'] as const;
  it('accepts prefs inside the allow-list with public https URLs', () =>
    expect(doorbellPrefsProblem(prefs, all)).toBeNull());
  it('refuses a sink turned on outside the allow-list, naming it', () =>
    expect(doorbellPrefsProblem(prefs, ['live', 'os'])).toBe(
      'the webhook sink is not allowed on this team',
    ));
  it('a sink turned off outside the allow-list is fine', () =>
    expect(
      doorbellPrefsProblem(DoorbellPrefsSchema.parse({ sinks: { slack: { on: false } } }), [
        'live',
      ]),
    ).toBeNull());
  it('refuses a private URL without echoing it', () => {
    const bad = DoorbellPrefsSchema.parse({
      sinks: { webhook: { on: true, url: 'https://192.168.1.4/hook-secret' } },
    });
    const problem = doorbellPrefsProblem(bad, all)!;
    expect(problem).toMatch(/^the webhook url must not point at a private/);
    expect(problem).not.toMatch(/192|secret/);
  });
  it('refuses a URL on a sink that takes none', () =>
    expect(
      doorbellPrefsProblem(
        DoorbellPrefsSchema.parse({ sinks: { os: { on: true, url: 'https://x.io' } } }),
        all,
      ),
    ).toBe('the os sink takes no url'));
});

describe('FEATURE_EPOCH (the doorbell, ADR 443)', () => {
  it('is 24 — a daemon behind it has no doorbell routes and drops the policy key', () =>
    expect(FEATURE_EPOCH).toBe(24));
});

describe('PolicySchema carries the doorbell', () => {
  it('parse({}) yields the default doorbell policy with no outbound URL', () => {
    const p = PolicySchema.parse({});
    expect(p.doorbell.allow).toEqual(['live', 'os', 'slack', 'webhook']);
    expect(p.doorbell.slack_url).toBeUndefined();
    expect(p.doorbell.webhook_url).toBeUndefined();
  });
});
