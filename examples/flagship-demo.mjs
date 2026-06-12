#!/usr/bin/env node
// Flagship 3-pane demo, runnable and recordable (e.g. `asciinema rec -c "node examples/flagship-demo.mjs"`).
// It runs the real server + real MCP adapter in-process and prints the human's live inbox view
// using the real CLI renderer. The automated source-of-truth version is tests/scenarios/flagship.test.ts.
//
// Build first: pnpm -r build
import { createServer, openDb } from '../packages/server/dist/index.js';
import { MusterdClient } from '../packages/mcp/dist/index.js';
import { renderMessageRow, renderBanner, renderStatusTable } from '../packages/cli/dist/render/rows.js';
import { makeEnvelope } from '../packages/protocol/dist/index.js';
import { ulid } from 'ulid';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (name) => (name === 'nick' ? 'human' : 'agent');

async function main() {
  process.env.MUSTERD_SILENT = '1';
  const server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;

  const api = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };

  console.log(renderBanner() + '\n');

  // Roster: nick (human, lead) creates dawn; Ada (backend) and Lin (frontend) join.
  const team = await api('POST', '/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human', role: 'lead' } });
  const ada = await api('POST', '/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, team.token);
  const lin = await api('POST', '/teams/dawn/members', { name: 'Lin', kind: 'agent', role: 'frontend' }, team.token);

  // The two agents attach via the MCP adapter, on different surfaces, and explicitly join
  // (M3: the adapter is dormant until it joins — registering the tools doesn't claim the seat).
  const adaC = new MusterdClient({ server: base, team: 'dawn', member: 'Ada', token: ada.token, surface: 'claude-code' });
  const linC = new MusterdClient({ server: base, team: 'dawn', member: 'Lin', token: lin.token, surface: 'codex' });
  await adaC.join();
  await linC.join();
  await delay(150);

  // Single-active: a second session trying to be Ada is refused (the "N minds, one name" bug, fixed).
  const adaDup = new MusterdClient({ server: base, team: 'dawn', member: 'Ada', token: ada.token, surface: 'claude-code' });
  try {
    await adaDup.join();
  } catch (err) {
    console.log('\x1b[2m── a 2nd session tried to be Ada ──\x1b[0m');
    console.log('  \x1b[31m✗ ' + String(err.message).replace(/^member_busy:\s*/, '') + '\x1b[0m\n');
  }
  adaDup.close();

  // nick is present and watching (what `musterd inbox --watch` does — holds a CLI presence).
  await api('POST', '/teams/dawn/presence', { surface: 'cli', status: 'online' }, team.token);

  console.log('\x1b[2m── pane 3: nick — musterd inbox --watch (dawn) ◉ watching ──\x1b[0m\n');

  let clock = Date.now();
  const post = async (from, token, to, act, body, meta, thread) => {
    const env = makeEnvelope({ id: ulid(), team: 'dawn', from, to, act, body, meta: meta ?? null, thread: thread ?? null, ts: ++clock });
    await api('POST', '/teams/dawn/messages', { envelope: env }, token);
    // The human sees team-scoped traffic in their watch stream.
    if (to.kind !== 'member' || to.name === 'nick') console.log(renderMessageRow(env, kindOf));
    await delay(700);
    return env;
  };

  await post('Ada', ada.token, { kind: 'team' }, 'status_update', 'taking the auth backend', { progress: 0.1 });
  await post('Lin', lin.token, { kind: 'team' }, 'status_update', 'taking the login UI', { progress: 0.1 });

  // A roster snapshot: both present agents now read as `working` (two-clocks rule) with their task.
  const roster = await api('GET', '/teams/dawn/members', undefined, team.token);
  console.log('\n\x1b[2m── musterd status (dawn) ──\x1b[0m');
  console.log(renderStatusTable(roster.members) + '\n');

  const help = await post('Lin', lin.token, { kind: 'team' }, 'request_help', 'what shape is the /session response?', { blocking: true });
  await post('nick', team.token, { kind: 'team' }, 'message', 'good q — Ada owns that contract');
  await post('Ada', ada.token, { kind: 'team' }, 'accept', '{ token, expiresAt } — sending a typed client', { in_reply_to: help.id }, help.id);
  await post('Ada', ada.token, { kind: 'member', name: 'Lin' }, 'handoff', 'session client ready in src/session.ts', { artifact: 'src/session.ts' });
  await post('Lin', lin.token, { kind: 'team' }, 'accept', 'wired in, tests green', { in_reply_to: help.id }, help.id);

  console.log('\n\x1b[2m── the team shipped: 1 human + 2 agents, 3 surfaces, one persistent team ──\x1b[0m');

  adaC.close();
  linC.close();
  await server.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
