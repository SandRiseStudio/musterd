import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, readNodeState, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { nodeCommand } from './node.js';
import { sendCommand } from './send.js';
import { teamCommand } from './team.js';

/**
 * `musterd node` (ADR 328) — the operator's five verbs.
 *
 * The join case runs against TWO daemons because that is the only shape in which it means
 * anything: the CLI asks its own local daemon to enroll, and the local daemon is what talks to the
 * hub. A single-server test would prove the opposite of the design.
 */

describe('node command', () => {
  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let dir: string;

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

  beforeEach(async () => {
    hub = createServer({ db: openDb(':memory:'), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    joiner = createServer({ db: openDb(':memory:'), port: 0 });

    dir = mkdtempSync(join(tmpdir(), 'musterd-node-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    // The operator's CLI points at the hub for the admin verbs.
    process.env['MUSTERD_SERVER'] = hubBase;
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await hub.close();
    await joiner.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['MUSTERD_NODE_STATE'];
  });

  it('mints an invite and prints the code once, with its expiry', async () => {
    const res = await capture(() => nodeCommand(parseArgs(['invite', '--label', 'joiner laptop'])));
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/msinv_/);
    // The operator has to know the window they are inside — an invite that looks durable is a
    // credential someone leaves in a chat message.
    expect(res.out).toMatch(/15 minutes|expires/i);
  });

  it('join asks the LOCAL daemon, which enrolls itself at the hub', async () => {
    const { out } = await capture(() =>
      nodeCommand(parseArgs(['invite', '--label', 'joiner laptop'])),
    );
    const code = /msinv_[\w-]+/.exec(out)![0];

    // Now act as the joining machine: same team, its own daemon.
    const joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
    process.env['MUSTERD_SERVER'] = joinerBase;
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    // Give the joiner a local node row the way a live daemon gets one — by writing to its log.
    await capture(() =>
      sendCommand(parseArgs(['--to', '@team', '--act', 'status_update', 'hello'])),
    );

    const res = await capture(() => nodeCommand(parseArgs(['join', hubBase, code])));

    expect(res.code).toBe(0);
    const saved = readNodeState().nodes['dawn'];
    expect(saved?.credential).toMatch(/^msnode_/);
    expect(saved?.hub_url).toBe(hubBase);
    // The credential went to disk, not to the terminal — a long-lived machine secret does not
    // belong in scrollback.
    expect(res.out).not.toContain('msnode_');

    // The load-bearing assertion: the id the HUB bound is the JOINER's own local node row. Both
    // daemons share MUSTERD_NODE_STATE in this test, so node.json alone cannot say which one
    // enrolled — this can. If the CLI had called the hub directly, or the hub had minted a fresh
    // identity, these two would differ.
    const joinerTeam = joiner.db
      .prepare<[string], { id: string }>('SELECT id FROM teams WHERE slug = ?')
      .get('dawn')!;
    const joinerNodeId = joiner.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(joinerTeam.id)!.node_id;
    expect(saved?.node_id).toBe(joinerNodeId);

    const hubTeam = hub.db
      .prepare<[string], { id: string }>('SELECT id FROM teams WHERE slug = ?')
      .get('dawn')!;
    const bound = hub.db
      .prepare<
        [string, string],
        { id: string }
      >('SELECT id FROM nodes WHERE team_id = ? AND id = ? AND credential_hash IS NOT NULL')
      .get(hubTeam.id, joinerNodeId);
    expect(bound?.id).toBe(joinerNodeId);
  });

  it('list masks credentials to the token kind', async () => {
    // With an ACTUAL enrolled node — listing an empty table would prove nothing about masking.
    const { out } = await capture(() => nodeCommand(parseArgs(['invite', '--label', 'laptop'])));
    const code = /msinv_[\w-]+/.exec(out)![0];
    const joined = await fetch(`${hubBase}/teams/dawn/nodes/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, node_id: 'node-remote', label: 'laptop' }),
    });
    const secret = ((await joined.json()) as { node_credential: string }).node_credential;

    const res = await capture(() => nodeCommand(parseArgs(['list'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('node-remote');
    expect(res.out).toContain('enrolled');
    expect(res.out).not.toContain(secret);
    // Not even a leading slice: the prefix shown is the token KIND, which every msnode_ shares.
    expect(res.out).not.toContain(secret.slice(0, 16));
  });

  it('rotate prints the new credential once; revoke reports whether it acted', async () => {
    // Enroll a node directly against the hub so there is something to rotate.
    const { out } = await capture(() => nodeCommand(parseArgs(['invite', '--label', 'laptop'])));
    const code = /msinv_[\w-]+/.exec(out)![0];
    await fetch(`${hubBase}/teams/dawn/nodes/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, node_id: 'node-remote', label: 'laptop' }),
    });

    const rotated = await capture(() => nodeCommand(parseArgs(['rotate', 'node-remote'])));
    expect(rotated.code).toBe(0);
    expect(rotated.out).toMatch(/msnode_/);

    const revoked = await capture(() => nodeCommand(parseArgs(['revoke', 'node-remote'])));
    expect(revoked.code).toBe(0);
    expect(revoked.out).toMatch(/revoked/i);

    // A second revoke must not claim to have done something.
    const again = await capture(() => nodeCommand(parseArgs(['revoke', 'node-remote'])));
    expect(again.out).toMatch(/already revoked|nothing/i);
  });

  it('refuses an unknown subcommand and a join missing its arguments', async () => {
    await expect(nodeCommand(parseArgs(['frobnicate']))).rejects.toThrow();
    await expect(nodeCommand(parseArgs(['join']))).rejects.toThrow();
    await expect(nodeCommand(parseArgs(['join', 'https://hub.example']))).rejects.toThrow();
    await expect(nodeCommand(parseArgs(['rotate']))).rejects.toThrow();
  });
});
