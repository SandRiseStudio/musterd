import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMcpConfig, MusterdClient } from '@musterd/mcp';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { captureSession } from '../../packages/cli/src/commands/session.js';

/**
 * The acceptance test for model attestation truth, end to end through the DB.
 *
 * Reproduces the incident: a workspace whose binding DECLARES one model while the harness is running
 * another, and proves the observation wins — on the roster, and in the audit trail. This is the test
 * that would have failed before the change, while every unit test still passed and the roster lied.
 */

let server: RunningServer;
let base: string;
let agentKey: string;
let grant: string;
let human: string;
let ws: string;
const clients: MusterdClient[] = [];

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

/** A workspace binding that DECLARES `model`, exactly as provisioning used to leave it. */
function writeWorkspace(declared?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-attest-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      server: base,
      team: 'dawn',
      agent_key: agentKey,
      grant,
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ada' },
      ...(declared !== undefined ? { model: declared } : {}),
    }),
  );
  return dir;
}

/** A harness transcript whose newest assistant turn reports `model` — the ground truth. */
function writeTranscript(dir: string, model: string): string {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(
    p,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model } }) + '\n',
  );
  return p;
}

/**
 * Load config the way a real adapter does — anchored on cwd. NOT via `MUSTERD_BINDING`: the ADR 143
 * seat-leak guard refuses a binding belonging to another workspace, so pointing the env at a temp
 * dir from inside this repo silently falls back to *this* workspace's seat and the test would assert
 * against the wrong binding entirely.
 */
async function connect(dir: string): Promise<MusterdClient> {
  const orig = process.cwd();
  process.chdir(dir);
  let config;
  try {
    config = loadMcpConfig({});
  } finally {
    process.chdir(orig);
  }
  const client = new MusterdClient({ ...config, connId: `conn-${clients.length}` });
  clients.push(client);
  await client.join();
  await new Promise((r) => setTimeout(r, 250)); // let the presence row land
  return client;
}

async function attestedModel(): Promise<string | null | undefined> {
  const roster = await api('GET', '/teams/dawn/members', undefined, human);
  const ada = roster.json.members.find((m: any) => m.name === 'Ada');
  return ada?.presences?.find((p: any) => p.status !== 'offline')?.model;
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  human = team.json.human_credential;
  agentKey = team.json.agent_key;
  await api('POST', '/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, human);
  const g = await api(
    'POST',
    '/teams/dawn/grants',
    { scope: 'seat', target: 'Ada', lifetime: 'standing' },
    human,
  );
  grant = g.json.token;
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (ws) rmSync(ws, { recursive: true, force: true });
  await server.close();
});

describe('model attestation truth (end to end)', () => {
  it('an observation overrides a stale declaration on the roster, and the correction is audited', async () => {
    ws = writeWorkspace('grok-4.5'); // the lie
    const transcript = writeTranscript(ws, 'claude-opus-4-8'); // the truth

    // 1. A session with only the stale declaration attests the lie — the pre-change behaviour.
    await connect(ws);
    expect(await attestedModel()).toBe('grok-4.5');

    // 2. The SessionStart hook observes what the harness is actually running.
    await captureSession('start', { session_id: 'sid-1', transcript_path: transcript, cwd: ws });

    // 3. The next session attests the OBSERVATION, with no human edit anywhere.
    clients.pop()?.close();
    await connect(ws);
    expect(await attestedModel()).toBe('claude-opus-4-8');

    // 4. The correction is on the record, not just in the rendering.
    const audit = await api('GET', '/teams/dawn/audit', undefined, human);
    const attested = (audit.json.entries ?? audit.json.audit ?? []).filter(
      (e: any) => e.action === 'occupancy.model_attested',
    );
    expect(attested.length).toBeGreaterThan(0);
    expect(JSON.stringify(attested)).toContain('claude-opus-4-8');
  });

  it('a seat with no observation still attests its declaration (no regression to unknown)', async () => {
    ws = writeWorkspace('grok-4.5');
    await connect(ws);
    expect(await attestedModel()).toBe('grok-4.5');
  });

  it('a seat with neither stays honestly unknown rather than guessing', async () => {
    ws = writeWorkspace(undefined);
    await connect(ws);
    expect(await attestedModel()).toBeFalsy();
  });
});
