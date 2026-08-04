import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import type { AutoRefreshCtx } from '../service/autorefresh.js';
import { AUTOREFRESH_LABEL } from '../service/launchd.js';
import type { RunResult, Runner, ServiceCtx } from '../service/manage.js';
import { serviceCommand } from './service.js';

/**
 * The `service refresh --auto` tick (ADR 118/130 fast-follow) — the quiet-period policy, exercised
 * through the injected runner + fake health + in-memory debounce store. It must: no-op a current
 * daemon (never rebuild/bounce when not behind), refresh straight through when idle, DEFER under
 * `idle` mode with live sessions, NOTIFY + force-bounce under `notice` mode with live sessions, and
 * debounce a tip whose build already failed so a broken main can't rebuild every interval forever.
 */
describe('service refresh --auto (the tick)', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];

  function ctx(runner: Runner): ServiceCtx {
    return {
      uid: 501,
      label: 'studio.sandrise.musterd',
      plistPath: join(dir, 'agent.plist'), // absent → daemonCheckout falls back to workingDir
      node: '/opt/homebrew/bin/node',
      binJs: '/repo/packages/cli/dist/bin.js',
      serveArgs: ['serve'],
      workingDir: '/repo',
      stdoutPath: join(dir, 'daemon.log'),
      stderrPath: join(dir, 'daemon.err.log'),
      path: '/usr/bin:/bin',
      run: runner,
      sleep: () => {},
      readFile: () => null,
    };
  }

  // Mocks the git/pnpm/launchctl surface the tick + refreshDaemon touch.
  function autoRunner(o: {
    behind: number;
    tip?: string;
    buildStatus?: number;
    dirty?: string;
  }): Runner {
    let head = 0;
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git') {
        if (args.includes('--is-inside-work-tree'))
          return { status: 0, stdout: 'true', stderr: '' };
        if (args.includes('--porcelain')) return { status: 0, stdout: o.dirty ?? '', stderr: '' };
        if (args.includes('rev-list')) return { status: 0, stdout: String(o.behind), stderr: '' };
        if (args.includes('rev-parse') && args.includes('origin/main'))
          return { status: 0, stdout: o.tip ?? 'newtip1111', stderr: '' };
        if (args.includes('--short'))
          return { status: 0, stdout: head++ === 0 ? 'aaa1111' : 'bbb2222', stderr: '' };
        return { status: 0, stdout: '', stderr: '' }; // fetch / switch
      }
      if (cmd === 'pnpm') return { status: o.buildStatus ?? 0, stdout: '', stderr: 'boom' };
      return { status: 0, stdout: '', stderr: '' }; // launchctl
    };
  }

  /**
   * A runner whose `origin/main` tip carries a committer timestamp, so the settle window has
   * something real to age. `tipAgeSeconds` is how long ago the newest commit landed; `oldestAge`
   * how long the daemon has been behind (the staleness the cap bounds).
   */
  function agedRunner(o: {
    behind: number;
    tipAgeSeconds: number;
    oldestAgeSeconds?: number;
    tip?: string;
  }): Runner {
    const now = Math.floor(Date.now() / 1000);
    let head = 0;
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== 'git') return { status: 0, stdout: '', stderr: '' };
      if (args.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (args.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('rev-list')) return { status: 0, stdout: String(o.behind), stderr: '' };
      if (args.includes('rev-parse') && args.includes('origin/main'))
        return { status: 0, stdout: o.tip ?? 'newtip1111', stderr: '' };
      // The two commit-time probes the settle window asks for (`git log … --format=%ct`).
      if (args.includes('log')) {
        const oldest = args.includes('--reverse');
        const age = oldest ? (o.oldestAgeSeconds ?? o.tipAgeSeconds) : o.tipAgeSeconds;
        return { status: 0, stdout: String(now - age) + '\n', stderr: '' };
      }
      if (args.includes('--short'))
        return { status: 0, stdout: head++ === 0 ? 'aaa1111' : 'bbb2222', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  const memState = (initial: string | null = null) => {
    let v = initial;
    return {
      read: () => v || null,
      write: vi.fn((sha: string) => {
        v = sha;
      }),
    };
  };

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  const tick = (over: {
    argv?: string[];
    ctx: ServiceCtx;
    health: () => Promise<{ connections?: number; build?: string }>;
    notify?: (n: { id: string; title: string; body: string }) => void;
    autoState?: { read: () => string | null; write: (sha: string) => void };
  }) =>
    capture(() =>
      serviceCommand(parseArgs(over.argv ?? ['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: over.ctx,
        health: over.health,
        notify: over.notify,
        // Default to a fresh in-memory store so tests never touch (or share) the real ~/.musterd stamp.
        autoState: over.autoState ?? memState(),
      }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autorefresh-tick-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('no-ops a current daemon — never rebuilds or bounces when not behind', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 0 })),
      health: async () => ({ connections: 5, build: 'newtip1111' }),
    });
    expect(code).toBe(0);
    expect(out).toContain('up to date');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
    expect(calls.some((x) => x.args.includes('switch'))).toBe(false);
  });

  it('refreshes straight through when the daemon is behind and idle (0 connections)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 2 })),
      health: async () => ({ connections: 0, build: 'oldsha0' }),
    });
    expect(code).toBe(0);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('build'))).toBe(true);
    expect(out).toContain('restarted the musterd daemon');
  });

  it('DEFERS under idle mode when live sessions are connected (no bounce)', async () => {
    const notify = vi.fn();
    const { code, out } = await tick({
      argv: ['refresh', '--auto', '--mode', 'idle'],
      ctx: ctx(autoRunner({ behind: 3 })),
      health: async () => ({ connections: 2, build: 'oldsha0' }),
      notify,
    });
    expect(code).toBe(0);
    expect(out).toContain('deferring refresh');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('NOTIFIES then force-bounces under notice mode when live sessions are connected', async () => {
    const notify = vi.fn();
    const { code, out } = await tick({
      argv: ['refresh', '--auto', '--mode', 'notice'],
      ctx: ctx(autoRunner({ behind: 1 })),
      health: async () => ({ connections: 4, build: 'oldsha0' }),
      notify,
    });
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].body).toMatch(/4 live sessions/);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('build'))).toBe(true);
    expect(out).toContain('restarted the musterd daemon');
  });

  it('debounces a tip whose build already failed (waits for a new commit)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 2, tip: 'deadbeef99' })),
      health: async () => ({ connections: 0, build: 'oldsha0' }),
      autoState: memState('deadbeef99'), // already attempted this exact tip
    });
    expect(code).toBe(0);
    expect(out).toContain('already attempted');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
  });

  // The #565 retry hole: an attempt that died for want of an install left the tip parked forever —
  // the debounce blocked every retry, and the only escape was a human `pnpm install` (2026-08-01).
  // node_modules out of sync with the lockfile means a retry runs an install first, so it has
  // genuinely new odds; the debounce must yield to that one state.
  it('retries a parked tip when node_modules is out of sync with the lockfile', async () => {
    const repo = mkdtempSync(join(dir, 'pinned-repo-'));
    mkdirSync(join(repo, 'node_modules', '.pnpm'), { recursive: true });
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock-v2\n');
    writeFileSync(join(repo, 'node_modules', '.pnpm', 'lock.yaml'), 'lock-v1\n');
    const { code, out } = await tick({
      ctx: { ...ctx(autoRunner({ behind: 2, tip: 'deadbeef99' })), workingDir: repo },
      health: async () => ({ connections: 0, build: 'oldsha0' }),
      autoState: memState('deadbeef99'), // parked — but the checkout is inconsistent
    });
    expect(code).toBe(0);
    expect(out).toContain('retrying deadbee');
    const pnpm = calls.filter((x) => x.cmd === 'pnpm').map((x) => x.args.join(' '));
    expect(pnpm[0]).toContain('install --frozen-lockfile');
    expect(pnpm.some((a) => a.includes('build'))).toBe(true);
  });

  it('marks the attempted tip BEFORE building, so a build failure debounces next time', async () => {
    const state = memState(null);
    await expect(
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 1, tip: 'freshtip77', buildStatus: 1 })),
        health: async () => ({ connections: 0, build: 'oldsha0' }),
        autoState: state,
      }),
    ).rejects.toThrow(/build failed/);
    expect(state.write).toHaveBeenCalledWith('freshtip77');
  });

  // The failure this whole loop hides: the debounce then parks the tip, so the daemon stays pinned on
  // old code across every LATER merge while /health answers cheerfully — and the only evidence is a
  // log nobody reads unprompted. An unattended tick must say so out loud, exactly once per tip.
  it('notifies the operator when the tick fails — a pinned daemon must not be log-only', async () => {
    const notify = vi.fn();
    await expect(
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 1, tip: 'freshtip77', buildStatus: 1 })),
        health: async () => ({ connections: 0, build: 'oldsha0' }),
        notify,
        autoState: memState(null),
      }),
    ).rejects.toThrow(/build failed/);
    const n = notify.mock.calls.at(-1)?.[0] as { title: string; body: string };
    expect(n.title).toContain('failed');
    expect(n.body).toContain('pinned');
    expect(n.body).toContain('refresh.log');
  });

  it('does NOT notify a failure when the tick succeeds', async () => {
    const notify = vi.fn();
    await tick({
      ctx: ctx(autoRunner({ behind: 2 })),
      health: async () => ({ connections: 0, build: 'oldsha0' }),
      notify,
    });
    expect(
      notify.mock.calls.some((c) => String((c[0] as { title: string }).title).includes('failed')),
    ).toBe(false);
  });

  // One merge must cost the operator ONE notification. Announcing up front spent a second one on a
  // tick that then failed, and a third when the retry finally landed — three OS notices for a daemon
  // that moved once (#631). The announcement is "your session is about to reconnect", so it belongs
  // after the build, where that is finally true.
  it('does NOT announce a bounce that never happens — a failed build notifies once, not twice', async () => {
    const notify = vi.fn();
    await expect(
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 1, tip: 'freshtip77', buildStatus: 1 })),
        health: async () => ({ connections: 4, build: 'oldsha0' }), // live sessions → notice mode
        notify,
        autoState: memState(null),
      }),
    ).rejects.toThrow(/build failed/);
    expect(notify).toHaveBeenCalledOnce();
    expect((notify.mock.calls[0]![0] as { title: string }).title).toContain('failed');
  });

  it('announces the bounce only after the build lands (so the notice is true when it fires)', async () => {
    const notify = vi.fn();
    const { code } = await tick({
      argv: ['refresh', '--auto', '--mode', 'notice'],
      ctx: ctx(autoRunner({ behind: 1 })),
      health: async () => ({ connections: 4, build: 'oldsha0' }),
      notify,
    });
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
    // The build ran before the operator was told anything; the restart came after.
    const order = calls.map((x) => `${x.cmd} ${x.args.join(' ')}`);
    const build = order.findIndex((c) => c.startsWith('pnpm') && c.includes('build'));
    const bounce = order.findIndex((c) => c.includes('kickstart') || c.includes('bootstrap'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(bounce).toBeGreaterThan(build);
  });

  // The tick runs unattended and its log is read after the fact, by a human asking why their
  // machine just did something. Undated lines cannot answer that: #631 was reported as "three
  // notifications per merge" and the log could neither confirm nor refute it, because nothing in it
  // said WHEN, and a fired notification left no trace at all.
  it('stamps every tick line with the local wall clock', async () => {
    const { out } = await tick({
      ctx: ctx(autoRunner({ behind: 0 })),
      health: async () => ({ connections: 0, build: 'newtip1111' }),
    });
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} .*up to date/m);
  });

  it('records every OS notification it fires, so the log can be checked against the screen', async () => {
    const { out } = await tick({
      argv: ['refresh', '--auto', '--mode', 'notice'],
      ctx: ctx(autoRunner({ behind: 1 })),
      health: async () => ({ connections: 4, build: 'oldsha0' }),
      notify: vi.fn(),
    });
    const ledger = out.split('\n').filter((l) => l.includes('notified the operator:'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
    expect(ledger[0]).toContain('musterd auto-refresh');
    expect(ledger[0]).toContain('4 live sessions'); // the body the operator actually saw
  });

  it('records the failure notice too — the one notification with no ✓ line of its own', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      await expect(
        serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
          platform: 'darwin',
          ctx: ctx(autoRunner({ behind: 1, tip: 'freshtip77', buildStatus: 1 })),
          health: async () => ({ connections: 4, build: 'oldsha0' }),
          notify: vi.fn(),
          autoState: memState(null),
        }),
      ).rejects.toThrow(/build failed/);
    } finally {
      spy.mockRestore();
    }
    const ledger = chunks
      .join('')
      .split('\n')
      .filter((l) => l.includes('notified the operator:'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain('failed');
  });

  // ADR 224. Log hygiene runs independently of the skew check, because the logs grow from the
  // daemon's own traffic rather than from refreshes — a machine that is perfectly up to date is
  // exactly the one whose logs nobody would otherwise be bounding.
  it('trims oversized service logs even on a tick that finds nothing to refresh', async () => {
    const trimLogs = vi.fn(() => [{ path: '/home/.musterd/daemon.log', before: 34_007_194 }]);
    const { out } = await capture(() =>
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 0 })),
        health: async () => ({ connections: 0, build: 'newtip1111' }),
        autoState: memState(),
        trimLogs,
      }),
    );
    expect(trimLogs).toHaveBeenCalledOnce();
    expect(out).toContain('up to date'); // the tick itself still no-ops
    expect(out).toMatch(/trimmed \/home\/\.musterd\/daemon\.log — 32\.4 MB over the cap/);
    expect(out).toContain('daemon.log.1');
  });

  it('says nothing about logs when they are all under the cap', async () => {
    const { out } = await capture(() =>
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 0 })),
        health: async () => ({ connections: 0, build: 'newtip1111' }),
        autoState: memState(),
        trimLogs: () => [],
      }),
    );
    expect(out).not.toContain('trimmed');
  });

  it('keeps the full confirmation budget after a known-healthy daemon bounces', async () => {
    let probes = 0;
    const health = async () => {
      probes++;
      // Initial tick + pre-bounce guard are healthy. The restarted daemon takes five polls
      // before it serves again; the short no-baseline budget must not turn this into a false fail.
      if (probes > 2 && probes < 8) throw new Error('ECONNREFUSED');
      return { connections: 0, build: probes < 8 ? 'oldsha0' : 'newtip1111' };
    };
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 1 })),
      health,
    });
    expect(code).toBe(0);
    expect(out).toContain('answered /health');
  });

  it('no-ops when the daemon is unreachable (watcher, never gatekeeper)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 5 })),
      health: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(code).toBe(0);
    expect(out).toContain('unreachable');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
  });
  /**
   * The settle window (measured 2026-08-03). The tick bounced the daemon on ANY skew, so a merge
   * burst became a bounce storm: 19 merges in a day meant 19 full sync → build → restart cycles,
   * each interrupting every live seat and pushing the operator a notification — including #610 at
   * 15:27 and #611 at 15:29, two complete bounces two minutes apart for a daemon that landed on the
   * same tip either way. nick read the volume as "even more autorefresh failures"; there were none.
   *
   * Modelled against that real merge trace, settle=600s with cap=900s turns 19 bounces into 12 while
   * bounding worst-case staleness at 15 minutes — which is where the defaults come from.
   */
  describe('the settle window (a merge burst is one bounce, not eleven)', () => {
    it('defers while the tip is still moving, and says so rather than looking stuck', async () => {
      const { code, out } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '600'],
        ctx: ctx(agedRunner({ behind: 2, tipAgeSeconds: 30 })),
        health: async () => ({ connections: 3, build: 'old111' }),
      });
      expect(code).toBe(0);
      expect(out).toMatch(/settl|still moving/i);
      // The whole point: no build, no bounce, no interruption of those 3 live sessions.
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(false);
      expect(calls.some((c) => c.args.includes('kickstart'))).toBe(false);
    });

    it('bounces once the tip has held still for the window', async () => {
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '600'],
        ctx: ctx(agedRunner({ behind: 2, tipAgeSeconds: 900 })),
        health: async () => ({ connections: 0, build: 'old111' }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true); // it built → it bounced
    });

    it('bounces anyway once the staleness cap is hit, however busy main stays', async () => {
      // The failure mode a naive settle window creates: a steadily-merging repo defers forever and
      // the daemon never updates. The cap is measured from the OLDEST unapplied commit, so a busy
      // main delays the bounce but can never cancel it.
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '600', '--settle-cap', '900'],
        ctx: ctx(agedRunner({ behind: 9, tipAgeSeconds: 20, oldestAgeSeconds: 1200 })),
        health: async () => ({ connections: 2, build: 'old111' }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('is off by default at --settle 0, so the old behaviour is one flag away', async () => {
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '0'],
        ctx: ctx(agedRunner({ behind: 1, tipAgeSeconds: 5 })),
        health: async () => ({ connections: 0, build: 'old111' }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('never defers a daemon that is already current — settle only gates a bounce', async () => {
      const { out } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '600'],
        ctx: ctx(agedRunner({ behind: 0, tipAgeSeconds: 5 })),
        health: async () => ({ connections: 0, build: 'old111' }),
      });
      expect(out).toContain('up to date');
    });

    // Inc 2 of the quiescence design (spec: docs/superpowers/specs/2026-08-03-quiescence-signal-
    // design.md): after the settle window passes, prefer a moment when no agent seat has acted for
    // the quiet floor. Same safety shape as settle: delay toward a lull, never cancel — the
    // staleness cap forces through both gates, and unknown degrades to bouncing.
    it('holds the bounce while an agent seat is actively working (quiet floor)', async () => {
      const { code, out } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '0', '--quiet-floor', '120'],
        // oldestAge stays under the cap — the cap forcing through the floor has its own test below.
        ctx: ctx(agedRunner({ behind: 2, tipAgeSeconds: 900, oldestAgeSeconds: 300 })),
        // A seat acted 5s ago — mid-burst of tool calls. Do not drop its socket now.
        health: async () => ({ connections: 3, build: 'old111', quietest_busy_ms: 5_000 }),
      });
      expect(code).toBe(0);
      expect(out).toMatch(/quiet|working/i);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(false);
    });

    it('bounces into a lull once every seat has been quiet past the floor', async () => {
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '0', '--quiet-floor', '120'],
        ctx: ctx(agedRunner({ behind: 2, tipAgeSeconds: 900 })),
        health: async () => ({ connections: 3, build: 'old111', quietest_busy_ms: 180_000 }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('bounces when the daemon does not report quiescence — unknown is not a hold', async () => {
      // An old daemon (or a fresh one with no agent action) omits the field. Degrade to today's
      // behaviour: the floor only ever acts on positive evidence of work.
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '0', '--quiet-floor', '120'],
        ctx: ctx(agedRunner({ behind: 2, tipAgeSeconds: 900 })),
        health: async () => ({ connections: 3, build: 'old111' }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('the staleness cap forces through the quiet floor, same as through settle', async () => {
      const { code } = await tick({
        argv: [
          'refresh',
          '--auto',
          '--mode',
          'notice',
          '--settle',
          '600',
          '--settle-cap',
          '900',
          '--quiet-floor',
          '120',
        ],
        ctx: ctx(agedRunner({ behind: 9, tipAgeSeconds: 1000, oldestAgeSeconds: 1200 })),
        // Busy right now — but we are past the cap, so freshness wins.
        health: async () => ({ connections: 4, build: 'old111', quietest_busy_ms: 3_000 }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('--quiet-floor 0 disables the gate entirely', async () => {
      const { code } = await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '0', '--quiet-floor', '0'],
        ctx: ctx(agedRunner({ behind: 1, tipAgeSeconds: 900 })),
        health: async () => ({ connections: 3, build: 'old111', quietest_busy_ms: 1_000 }),
      });
      expect(code).toBe(0);
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });

    it('bounces when the commit time is unreadable — never defer on ignorance', async () => {
      // An unreadable timestamp must degrade to today's behaviour, not to an indefinite hold.
      const runner: Runner = (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd !== 'git') return { status: 0, stdout: '', stderr: '' };
        if (args.includes('--is-inside-work-tree'))
          return { status: 0, stdout: 'true', stderr: '' };
        if (args.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
        if (args.includes('rev-list')) return { status: 0, stdout: '2', stderr: '' };
        if (args.includes('rev-parse') && args.includes('origin/main'))
          return { status: 0, stdout: 'newtip1111', stderr: '' };
        if (args.includes('log')) return { status: 128, stdout: '', stderr: 'bad object' };
        return { status: 0, stdout: 'aaa1111', stderr: '' };
      };
      await tick({
        argv: ['refresh', '--auto', '--mode', 'notice', '--settle', '600'],
        ctx: ctx(runner),
        health: async () => ({ connections: 0, build: 'old111' }),
      });
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(true);
    });
  });
});

describe('service <verb> --auto (lifecycle dispatch)', () => {
  let dir: string;
  const runner: Runner = (): RunResult => ({ status: 0, stdout: '', stderr: '' });

  const daemonCtx = (): ServiceCtx => ({
    uid: 501,
    label: 'studio.sandrise.musterd',
    plistPath: join(dir, 'agent.plist'),
    node: '/n',
    binJs: '/repo/packages/cli/dist/bin.js',
    serveArgs: ['serve'],
    workingDir: '/repo',
    stdoutPath: '/l',
    stderrPath: '/e',
    path: '/p',
    run: runner,
    sleep: () => {},
    readFile: () => null,
  });

  const arCtx = (): AutoRefreshCtx => ({
    uid: 501,
    label: AUTOREFRESH_LABEL,
    plistPath: join(dir, 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`),
    node: '/n',
    binJs: '/repo/packages/cli/dist/bin.js',
    refreshArgs: ['refresh', '--auto', '--mode', 'idle'],
    workingDir: '/repo',
    logPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    errLogPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    path: '/p',
    intervalSeconds: 90,
    run: runner,
    sleep: () => undefined,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autorefresh-dispatch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install --auto writes the auto-refresher plist and reports the cadence + mode', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await serviceCommand(parseArgs(['install', '--auto', '--mode', 'idle']), {
        platform: 'darwin',
        ctx: daemonCtx(),
        autoRefreshCtx: arCtx(),
      });
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(code).toBe(0);
    const plistPath = join(dir, 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toContain('<string>--auto</string>');
    expect(out).toContain('installed + started the daemon auto-refresher');
    expect(out).toContain('every 90s');
    expect(out).toContain('idle only'); // the mode's quiet-period summary
  });
});
