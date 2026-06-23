import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, type Envelope } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { notifyCommand } from '../commands/notify.js';
import { teamCommand } from '../commands/team.js';
import { buildNotifyCommand, type NotifyItem } from './os.js';
import { pendingToNotify, pollOnce, toNotifyItem, type NotifyDeps } from './select.js';

// ---- pure: buildNotifyCommand (the platform branch + injection-safety) ----

describe('buildNotifyCommand', () => {
  const item: NotifyItem = {
    id: '1',
    title: 'musterd · lin needs help',
    body: 'deploy is on fire',
  };

  it('macOS: passes dynamic strings as argv, never into the script source', () => {
    const cmd = buildNotifyCommand('darwin', item);
    expect(cmd).not.toBeNull();
    expect(cmd!.cmd).toBe('osascript');
    // The body/title are the trailing argv items, after the `-e` script lines.
    expect(cmd!.args).toContain(item.body);
    expect(cmd!.args).toContain(item.title);
    // Injection-safety: no `-e` line contains the body — it can only ever be argv data.
    const scriptLines = cmd!.args.filter((_, i) => cmd!.args[i - 1] === '-e');
    expect(scriptLines.some((l) => l.includes(item.body))).toBe(false);
    expect(scriptLines.some((l) => l.includes('item 1 of argv'))).toBe(true);
  });

  it('Linux: title and body are separate notify-send argv (nothing to escape)', () => {
    const cmd = buildNotifyCommand('linux', item);
    expect(cmd).toEqual({ cmd: 'notify-send', args: [item.title, item.body] });
  });

  it('unsupported platform: returns null (caller no-ops)', () => {
    expect(buildNotifyCommand('win32', item)).toBeNull();
  });
});

// ---- pure: selection + rendering ----

function env(over: Partial<Envelope> & Pick<Envelope, 'act' | 'from' | 'to'>): Envelope {
  return makeEnvelope({
    id: over.id ?? ulid(),
    team: 'dawn',
    from: over.from,
    to: over.to,
    act: over.act,
    body: over.body ?? '',
    thread: over.thread ?? null,
    meta: over.meta ?? null,
  });
}

const toNick = { kind: 'member', name: 'nick' } as const;

describe('pendingToNotify', () => {
  it('flags request_help and acts directed at me; ignores ambient + already-seen', () => {
    const msgs = [
      env({ act: 'request_help', from: 'lin', to: { kind: 'team' } }),
      env({ act: 'handoff', from: 'lin', to: toNick }),
      env({ act: 'status_update', from: 'lin', to: { kind: 'team' } }), // quiet
      env({ act: 'message', from: 'lin', to: { kind: 'member', name: 'bo' } }), // not me
    ];
    const picked = pendingToNotify(msgs, 'nick', new Set());
    expect(picked.map((m) => m.act).sort()).toEqual(['handoff', 'request_help']);
  });

  it('drops an item once it is in the seen set (non-nagging within a run)', () => {
    const help = env({ act: 'request_help', from: 'lin', to: { kind: 'team' } });
    const seen = new Set<string>([help.id]);
    expect(pendingToNotify([help], 'nick', seen)).toEqual([]);
  });

  it('drops a resolved thread (a closed request no longer waits, ADR 025)', () => {
    const help = env({ act: 'request_help', from: 'lin', to: { kind: 'team' } });
    const done = env({ act: 'resolve', from: 'nick', to: { kind: 'team' }, thread: help.id });
    expect(pendingToNotify([help, done], 'nick', new Set())).toEqual([]);
  });
});

describe('toNotifyItem', () => {
  it('titles by act and carries the body', () => {
    const item = toNotifyItem(env({ act: 'request_help', from: 'lin', to: toNick, body: 'help' }));
    expect(item.title).toBe('musterd · lin needs help');
    expect(item.body).toBe('help');
  });

  it('falls back to the act when the body is empty', () => {
    const item = toNotifyItem(env({ act: 'handoff', from: 'lin', to: toNick }));
    expect(item.body).toBe('(handoff)');
  });

  it('titles accept/decline/message replies to my request distinctly', () => {
    const t = (act: 'accept' | 'decline' | 'message') =>
      toNotifyItem(
        env({
          act,
          from: 'lin',
          to: toNick,
          // accept/decline must answer a message (act-meta rule); message needs nothing.
          meta: act === 'message' ? null : { in_reply_to: ulid() },
        }),
      ).title;
    expect(t('accept')).toBe('musterd · lin accepted your request');
    expect(t('decline')).toBe('musterd · lin declined your request');
    expect(t('message')).toBe('musterd · lin messaged you');
  });
});

// ---- pollOnce: dedupe + reachability suppression with fakes ----

describe('pollOnce', () => {
  const help = env({ act: 'request_help', from: 'lin', to: toNick, body: 'deploy is failing' });

  it('fires once per item and suppresses the re-poll while it stays unread', async () => {
    const fired: NotifyItem[] = [];
    const seen = new Set<string>();
    const deps: NotifyDeps = {
      me: 'nick',
      inbox: async () => [help],
      isReachable: async () => false, // away
      notify: (n) => fired.push(n),
    };
    expect((await pollOnce(deps, seen)).length).toBe(1);
    expect((await pollOnce(deps, seen)).length).toBe(0); // dedupe
    expect(fired).toHaveLength(1);
    expect(fired[0]!.title).toContain('lin needs help');
  });

  it('suppresses when the human is watching (the bell already reached them, ADR 024)', async () => {
    const fired: NotifyItem[] = [];
    const seen = new Set<string>();
    const deps: NotifyDeps = {
      me: 'nick',
      inbox: async () => [help],
      isReachable: async () => true, // a live watch pane
      notify: (n) => fired.push(n),
    };
    expect(await pollOnce(deps, seen)).toEqual([]);
    expect(fired).toHaveLength(0);
    // Marked seen, so it is treated as already-reached and won't fire after the pane closes.
    expect(seen.has(help.id)).toBe(true);
  });
});

// ---- integration: real server, real cursor (dedupe clears on read) ----

describe('notify against a live daemon', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-notify-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    // `team create` auto-binds the cwd (ADR 036) — point cwd at a throwaway dir so the binding
    // (and the notifier's resolved identity) land in the temp, not the real repo.
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

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

  /** Stand up team `dawn` (nick = creator/admin) + agent `lin`; return their tokens. */
  async function setup(): Promise<{ nickToken: string; linToken: string }> {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    const added = await capture(() =>
      teamCommand(parseArgs(['add', 'lin', '--kind', 'agent', '--json'])),
    );
    const linToken = JSON.parse(added.out).token as string;
    const nickToken = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).identities.dawn
      .token as string;
    return { nickToken, linToken };
  }

  it('fires for a request_help to an away human, then self-clears once the inbox is read', async () => {
    const { nickToken, linToken } = await setup();
    const lin = new HttpClient({ server: serverUrl, token: linToken });
    await lin.send(
      'dawn',
      makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: 'lin',
        to: toNick,
        act: 'request_help',
        body: 'deploy is failing',
        thread: null,
        meta: null,
      }),
    );

    const nick = new HttpClient({ server: serverUrl, token: nickToken });
    const fired: NotifyItem[] = [];
    const seen = new Set<string>();
    const deps: NotifyDeps = {
      me: 'nick',
      inbox: async () => (await nick.inbox('dawn', { unread: true })).messages,
      isReachable: async () => {
        const roster = await nick.roster('dawn');
        const me = roster.members.find((m) => m.name === 'nick');
        return me != null && me.presence !== 'offline';
      },
      notify: (n) => fired.push(n),
    };

    // Away (no live presence) → fires; re-poll dedupes off the in-memory seen set.
    expect((await pollOnce(deps, seen)).length).toBe(1);
    expect((await pollOnce(deps, seen)).length).toBe(0);
    expect(fired[0]!.body).toBe('deploy is failing');

    // Reading the inbox advances the durable cursor → a *fresh* notifier no longer sees it.
    const unread = await nick.inbox('dawn', { unread: true });
    await nick.markRead('dawn', unread.messages[unread.messages.length - 1]!.id);
    expect(await pollOnce(deps, new Set())).toEqual([]);
  });

  it('command --once wiring: resolves identity and fires via the injected sink', async () => {
    const { linToken } = await setup();
    const lin = new HttpClient({ server: serverUrl, token: linToken });
    await lin.send(
      'dawn',
      makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: 'lin',
        to: toNick,
        act: 'request_help',
        body: 'prod alert',
        thread: null,
        meta: null,
      }),
    );

    const fired: NotifyItem[] = [];
    const code = await capture(() =>
      notifyCommand(parseArgs(['--once']), { notify: (n) => fired.push(n) }),
    ).then((r) => r.code);
    expect(code).toBe(0);
    expect(fired.map((n) => n.title)).toEqual(['musterd · lin needs help']);
  });

  it('resident loop: fires on the immediate first poll, then stops on SIGINT', async () => {
    const { linToken } = await setup();
    const lin = new HttpClient({ server: serverUrl, token: linToken });
    await lin.send(
      'dawn',
      makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: 'lin',
        to: toNick,
        act: 'request_help',
        body: 'pager went off',
        thread: null,
        meta: null,
      }),
    );

    const fired: NotifyItem[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // No --once: starts the resident poll loop, whose first tick runs immediately.
      const done = notifyCommand(parseArgs([]), { notify: (n) => fired.push(n) });
      await new Promise((r) => setTimeout(r, 80)); // let the first poll resolve
      process.emit('SIGINT');
      expect(await done).toBe(0);
    } finally {
      spy.mockRestore();
      process.removeAllListeners('SIGINT');
    }
    expect(fired.map((n) => n.title)).toEqual(['musterd · lin needs help']);
  });
});
