import type { DoorbellRecord } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { buildNotifyCommand, type NotifyItem, osNotifyDelivered } from '../notify/os.js';
import { type DoorbellClient, doorbellBanner, pollDoorbellOnce } from './doorbell.js';
import type { HostRegistryEntry } from './registry.js';

const entry = (seat: string, host: string, team = 'revive'): HostRegistryEntry => ({
  server: 'http://127.0.0.1:7777',
  team,
  seat,
  workspace: `/ws/${seat}`,
  harness: 'claude-code',
  host,
  updated_at: 1,
});

const record = (over: Partial<DoorbellRecord> = {}): DoorbellRecord => ({
  team: 'revive',
  from: 'dolly',
  act: 'ask',
  species: 'approve',
  tier: 'blocking',
  act_id: '01X',
  answer_path: '/live?act=01X',
  ...over,
});

/** A fake daemon: rings queued per host label, claimed once, reports recorded. */
function fakeDaemon(
  queued: Record<string, { id: string; member: string; record: DoorbellRecord }[]>,
) {
  const polls: string[] = [];
  const reports: { ring: string; host: string; ok: boolean }[] = [];
  const client: DoorbellClient = {
    rings: async (_team, host) => {
      polls.push(host);
      const rings = queued[host] ?? [];
      queued[host] = [];
      return { rings };
    },
    surfaced: async (_team, ring, host, ok) => {
      reports.push({ ring, host, ok });
    },
  };
  return { client, polls, reports };
}

function deps(
  entries: HostRegistryEntry[],
  client: DoorbellClient,
  notified: NotifyItem[],
  lines: string[] = [],
) {
  return {
    log: (l: string) => lines.push(l),
    loadRegistry: () => ({ entries }),
    readAgentKey: () => 'mskey_test',
    doorbellClientFor: () => client,
    notify: async (n: NotifyItem) => {
      notified.push(n);
      return true;
    },
  };
}

describe('pollDoorbellOnce — the os sink on the host (ADR 443)', () => {
  it('raises one banner per ring for this machine’s label, and reports each', async () => {
    const d = fakeDaemon({ 'mac-a': [{ id: 'r1', member: 'nick', record: record() }] });
    const notified: NotifyItem[] = [];
    expect(await pollDoorbellOnce(deps([entry('izzo', 'mac-a')], d.client, notified))).toBe(1);
    expect(notified).toEqual([
      { id: 'r1', title: 'musterd [revive]', body: 'dolly needs your approval (blocking)' },
    ]);
    expect(d.reports).toEqual([{ ring: 'r1', host: 'mac-a', ok: true }]);
  });

  it('asks only for its own labels — another machine’s rings stay there', async () => {
    const d = fakeDaemon({
      'mac-a': [{ id: 'r1', member: 'nick', record: record() }],
      'mac-b': [{ id: 'r2', member: 'nick', record: record() }],
    });
    const notified: NotifyItem[] = [];
    await pollDoorbellOnce(deps([entry('izzo', 'mac-a')], d.client, notified));
    expect(d.polls).toEqual(['mac-a']);
    expect(notified.map((n) => n.id)).toEqual(['r1']);
  });

  it('polls once per label even with several seats enrolled under it', async () => {
    const d = fakeDaemon({});
    await pollDoorbellOnce(deps([entry('izzo', 'mac-a'), entry('dolly', 'mac-a')], d.client, []));
    expect(d.polls).toEqual(['mac-a']);
  });

  it('a second poll raises nothing twice', async () => {
    const d = fakeDaemon({ 'mac-a': [{ id: 'r1', member: 'nick', record: record() }] });
    const notified: NotifyItem[] = [];
    const run = deps([entry('izzo', 'mac-a')], d.client, notified);
    await pollDoorbellOnce(run);
    await pollDoorbellOnce(run);
    expect(notified).toHaveLength(1);
  });

  it('a quiet tick logs nothing; a failed poll logs one line and does not throw', async () => {
    const lines: string[] = [];
    await pollDoorbellOnce(deps([entry('izzo', 'mac-a')], fakeDaemon({}).client, [], lines));
    expect(lines).toEqual([]);
    const down: DoorbellClient = {
      rings: async () => {
        throw new Error('ECONNREFUSED');
      },
      surfaced: async () => undefined,
    };
    await expect(pollDoorbellOnce(deps([entry('izzo', 'mac-a')], down, [], lines))).resolves.toBe(
      0,
    );
    expect(lines).toEqual(['! doorbell poll failed for revive: ECONNREFUSED']);
  });

  it('a notifier process that fails is reported ok:false — ok comes from the exit, not the call', async () => {
    const d = fakeDaemon({ 'mac-a': [{ id: 'r1', member: 'nick', record: record() }] });
    const run = {
      ...deps([entry('izzo', 'mac-a')], d.client, []),
      notify: (n: NotifyItem) =>
        osNotifyDelivered(n, {
          platform: 'darwin',
          exec: (_cmd, _args, done) => setTimeout(() => done(new Error('exit 1')), 1),
        }),
    };
    expect(await pollDoorbellOnce(run)).toBe(0);
    expect(d.reports).toEqual([{ ring: 'r1', host: 'mac-a', ok: false }]);
  });

  it('a notifier that throws is reported ok:false, not rethrown', async () => {
    const d = fakeDaemon({ 'mac-a': [{ id: 'r1', member: 'nick', record: record() }] });
    const run = {
      ...deps([entry('izzo', 'mac-a')], d.client, []),
      notify: (): Promise<boolean> => {
        throw new Error('no osascript');
      },
    };
    expect(await pollDoorbellOnce(run)).toBe(0);
    expect(d.reports).toEqual([{ ring: 'r1', host: 'mac-a', ok: false }]);
  });
});

describe('osNotifyDelivered — did the platform notifier take the banner?', () => {
  const banner = { id: 'r', title: 't', body: 'b' };
  it('false on a platform with no notifier', async () =>
    expect(await osNotifyDelivered(banner, { platform: 'win32', exec: () => undefined })).toBe(
      false,
    ));
  it('false when the notifier exits with an error', async () =>
    expect(
      await osNotifyDelivered(banner, {
        platform: 'linux',
        exec: (_c, _a, done) => done(new Error('ENOENT')),
      }),
    ).toBe(false));
  it('false when spawning throws', async () =>
    expect(
      await osNotifyDelivered(banner, {
        platform: 'linux',
        exec: () => {
          throw new Error('spawn');
        },
      }),
    ).toBe(false));
  it('true only once the notifier exits cleanly', async () => {
    const seen: string[] = [];
    const ok = await osNotifyDelivered(banner, {
      platform: 'linux',
      exec: (cmd, _a, done) => {
        seen.push(cmd);
        done(null);
      },
    });
    expect([ok, seen]).toEqual([true, ['notify-send']]);
  });
});

describe('doorbellBanner — record fields only', () => {
  it.each([
    [record({ species: 'consult', tier: 'standard' }), 'dolly asks what you think (standard)'],
    [record({ species: 'escalate', tier: undefined }), 'dolly escalated to you'],
    [record({ act: 'handoff', species: undefined, tier: undefined }), 'dolly handed you work'],
    [record({ act: 'request_help', species: undefined, tier: undefined }), 'dolly needs your help'],
  ])('%#: %s', (rec, body) => expect(doorbellBanner('r', rec).body).toBe(body));

  it('a hostile sender name reaches osascript as argv, never as script source', () => {
    const hostile = 'x" & do shell script "rm -rf ~" & "';
    const banner = doorbellBanner('r', record({ from: hostile }));
    const cmd = buildNotifyCommand('darwin', banner)!;
    const script = cmd.args.filter((_, i) => cmd.args[i - 1] === '-e').join('\n');
    expect(script).not.toContain('rm -rf');
    expect(cmd.args).toContain(banner.body);
  });
});
