import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bind } from './bind.js';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { autojoin, buildMcpServer } from './index.js';

/**
 * The ritual probe (standing-context spec 2026-08-03). The join/inbox/status loop is taught by
 * guidance text — the primer, the hook nudges, the tool descriptions — and the trim increment
 * rewrites all three. This pins the loop as BEHAVIOUR, through a real daemon: autojoin on the first
 * tool call, a directed act showing up in the inbox, a status_update landing and flipping the
 * roster. Nothing here asserts on wording, so any rewording that keeps the loop working keeps this
 * green — and any trim that breaks the loop fails here, not in production.
 */

let server: RunningServer;
let base: string;
let nickToken: string;
let agentKey: string;
let adaGrant: string;
let tmpCwd: string;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeEach(async () => {
  // team_join persists a binding to process.cwd() — pin cwd to a temp dir so this suite can never
  // write .musterd/binding.json into the real repo (mcp.test.ts learned that the hard way).
  tmpCwd = mkdtempSync(pathJoin(tmpdir(), 'musterd-ritual-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);

  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  nickToken = team.json.human_credential;
  agentKey = team.json.agent_key;
  await api(
    'POST',
    '/teams/dawn/members',
    { name: 'Ada', kind: 'agent', role: 'backend' },
    nickToken,
  );
  const grant = await api(
    'POST',
    '/teams/dawn/grants',
    { scope: 'seat', target: 'Ada', lifetime: 'standing' },
    nickToken,
  );
  adaGrant = grant.json.token;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(tmpCwd, { recursive: true, force: true });
});

function adaConfig(): McpConfig {
  return {
    server: base,
    team: 'dawn',
    agent_key: agentKey,
    grant: adaGrant,
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    connId: 'conn-ritual',
    claimCode: 'RT12',
    bindingDir: tmpCwd,
  } as McpConfig;
}

/** Reach the registered handler for a tool the way a harness call would. */
function toolCb(mcp: ReturnType<typeof buildMcpServer>, name: string) {
  return (
    mcp as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
    }
  )._registeredTools[name]!.handler;
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('the join/inbox/status ritual (behaviour, not wording)', () => {
  it('the first tool call joins the seat, and the roster shows it present', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client);
    expect(client.joined).toBe(false);

    const mcp = buildMcpServer(client, adaConfig(), {
      onFirstToolCall: () => autojoin(client, adaConfig()),
    });
    // Any team_* tool — the seat must be on the team afterwards without an explicit team_join.
    await Promise.resolve(toolCb(mcp, 'team_members')({}));

    await vi.waitFor(() => expect(client.joined).toBe(true));
    const roster = await api('GET', '/teams/dawn/members', undefined, nickToken);
    const ada = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(ada.presence).toBe('online');
    client.close();
  }, 15_000);

  it('a directed act sent to the seat comes back out of team_inbox_check', async () => {
    const client = new MusterdClient(adaConfig());
    await client.join();
    const mcp = buildMcpServer(client, adaConfig());

    await api(
      'POST',
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'ritual1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'request_help',
          body: 'ritual-probe-directed-body',
          ts: Date.now(),
        },
      },
      nickToken,
    );

    await vi.waitFor(async () => {
      const text = resultText(await toolCb(mcp, 'team_inbox_check')({}));
      expect(text).toContain('ritual-probe-directed-body');
    });
    client.close();
  }, 15_000);

  it('team_send status_update lands as a real message the team can read back', async () => {
    const client = new MusterdClient(adaConfig());
    await client.join();
    // `team_send` needs the resolved seat identity a claimed config carries.
    const mcp = buildMcpServer(client, { ...adaConfig(), member: 'Ada' } as McpConfig);

    const sent = await toolCb(
      mcp,
      'team_send',
    )({
      to: '@team',
      act: 'status_update',
      body: 'ritual-probe-status-body',
    });
    expect(resultText(sent)).toMatch(/\S/);

    const messages = await api('GET', '/teams/dawn/messages', undefined, nickToken);
    const mine = messages.json.messages.find((m: any) => m.body === 'ritual-probe-status-body');
    expect(mine).toBeTruthy();
    expect(mine.act).toBe('status_update');
    expect(mine.from).toBe('Ada');
    client.close();
  }, 15_000);
});
