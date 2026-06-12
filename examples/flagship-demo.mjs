#!/usr/bin/env node
// Flagship demo, runnable and recordable (vhs docs/flagship.tape — see docs/demo.md).
// It runs the real server + real MCP adapter in-process and prints the human's live inbox view
// using the real CLI renderer — a *scripted walkthrough* of a real session (the agents' lines are
// scripted; the server, protocol, presence, and rendering are real). The automated source-of-truth
// is tests/scenarios/flagship.test.ts; the authentic launch cut is the 3-pane recording (docs/demo.md).
//
// Two cuts from one script:
//   node examples/flagship-demo.mjs              # lean header cut (~25s) — the README GIF
//   DEMO_FULL=1 node examples/flagship-demo.mjs  # full cut — adds single-active + the private handoff
//
// Build first: pnpm -r build
import { createServer, openDb } from '../packages/server/dist/index.js';
import { MusterdClient } from '../packages/mcp/dist/index.js';
import { renderMessageRow, renderBanner, renderStatusTable } from '../packages/cli/dist/render/rows.js';
import { makeEnvelope } from '../packages/protocol/dist/index.js';
import { ulid } from 'ulid';

const FULL = process.env.DEMO_FULL === '1';
const k = FULL ? 1 : 0.72; // the header cut runs ~28% tighter
const ms = (n) => Math.round(n * k);
const delay = (n) => new Promise((r) => setTimeout(r, n));
const kindOf = (name) => (name === 'nick' ? 'human' : 'agent');

// --- tiny presentation helpers (narration + pacing) ---
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** A narration caption: a dim "▸ …" line explaining the beat, then a beat to read it. */
async function caption(text, hold = 1400) {
  console.log('\n' + dim('▸ ') + dim(text));
  await delay(ms(hold));
}

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

  console.log('\n' + renderBanner() + '\n');
  await delay(ms(1400));

  // --- Who's on the team, and what they're here to do (the premise) ---
  await caption('One team. Two AI agents and a human, each in a different tool. They ship a login feature together.', 1900);
  console.log('  ' + bold('The team ') + dim('“dawn” —'));
  console.log('    ' + cyan('nick') + dim('  ·  human, lead          ·  watching from the CLI'));
  console.log('    ' + yellow('Ada') + dim('   ·  agent, backend        ·  running in Claude Code'));
  console.log('    ' + yellow('Lin') + dim('   ·  agent, frontend       ·  running in Codex'));
  await delay(ms(2400));

  const team = await api('POST', '/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human', role: 'lead' } });
  const ada = await api('POST', '/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, team.token);
  const lin = await api('POST', '/teams/dawn/members', { name: 'Lin', kind: 'agent', role: 'frontend' }, team.token);

  // The two agents attach via the MCP adapter, on different surfaces, and explicitly join
  // (the adapter is dormant until it joins — registering the tools doesn't claim the seat).
  const adaC = new MusterdClient({ server: base, team: 'dawn', member: 'Ada', token: ada.token, surface: 'claude-code' });
  const linC = new MusterdClient({ server: base, team: 'dawn', member: 'Lin', token: lin.token, surface: 'codex' });

  await caption('Each agent joins the team from its own tool, and comes online.', 1300);
  await adaC.join();
  console.log('    ' + green('●') + ' ' + yellow('Ada') + ' joined ' + dim('via claude-code'));
  await delay(ms(800));
  await linC.join();
  console.log('    ' + green('●') + ' ' + yellow('Lin') + ' joined ' + dim('via codex'));
  await delay(ms(1500));

  // Single-active (full cut only): a second session trying to be Ada is refused. It's a strong feature,
  // but it's a digression for a first-touch header GIF — so it lives in the full cut, Scenario C, and the post.
  if (FULL) {
    await caption('A member is one identity — not many sessions. A second client can’t impersonate Ada:', 1700);
    const adaDup = new MusterdClient({ server: base, team: 'dawn', member: 'Ada', token: ada.token, surface: 'claude-code' });
    try {
      await adaDup.join();
    } catch (err) {
      console.log('    ' + red('✗ ' + String(err.message).replace(/^member_busy:\s*/, '')));
    }
    adaDup.close();
    await delay(ms(1900));
  }

  // nick is present and watching (what `musterd inbox --watch` does — holds a CLI presence).
  await api('POST', '/teams/dawn/presence', { surface: 'cli', status: 'online' }, team.token);

  await caption("Now nick watches the team work, live — this is nick's terminal:", 1500);
  console.log(dim('  ┌─ ') + cyan('nick') + dim(' · musterd inbox --watch (dawn) ') + green('◉ watching') + dim(' ───'));
  await delay(ms(1100));

  let clock = Date.now();
  // Print a beat into nick's watch stream: an optional caption, then the real message row.
  const beat = async (from, token, to, act, body, meta, thread, note, hold = 1600) => {
    if (note) await caption(note, 1200);
    const env = makeEnvelope({ id: ulid(), team: 'dawn', from, to, act, body, meta: meta ?? null, thread: thread ?? null, ts: ++clock });
    await api('POST', '/teams/dawn/messages', { envelope: env }, token);
    // The human sees team-scoped traffic in their watch stream.
    if (to.kind !== 'member' || to.name === 'nick') console.log(dim('  │ ') + renderMessageRow(env, kindOf).replace(/\n/g, '\n  ' + dim('│ ')));
    await delay(ms(hold));
    return env;
  };

  await beat('Ada', ada.token, { kind: 'team' }, 'status_update', 'taking the auth backend', { progress: 0.1 },
    null, 'Each agent says what it’s picking up — a typed status_update, not chat:');
  await beat('Lin', lin.token, { kind: 'team' }, 'status_update', 'taking the login UI', { progress: 0.1 });

  // A roster snapshot: both present agents now read as `working` (two-clocks rule) with their task.
  await caption('At any moment, the roster shows who’s online and what they’re working on:', 1500);
  const roster = await api('GET', '/teams/dawn/members', undefined, team.token);
  console.log(renderStatusTable(roster.members).split('\n').map((l) => '    ' + l).join('\n'));
  await delay(ms(2400));

  const help = await beat('Lin', lin.token, { kind: 'team' }, 'request_help', 'what shape is the /session response?', { blocking: true },
    null, 'Lin gets blocked and asks the team for help — request_help, so everyone sees it:');
  await beat('nick', team.token, { kind: 'team' }, 'message', 'good q — Ada owns that contract', null,
    null, 'nick is a peer, not an approver — he just chimes in:');
  await beat('Ada', ada.token, { kind: 'team' }, 'accept', '{ token, expiresAt } — sending Lin a typed client', { in_reply_to: help.id }, help.id,
    'Ada answers and accepts the work — the reply is threaded to Lin’s question:');

  if (FULL) {
    // Member-scoped: a private 1:1 transfer, deliberately not shown in nick's team stream.
    await beat('Ada', ada.token, { kind: 'member', name: 'Lin' }, 'handoff', 'session client ready in src/session.ts', { artifact: 'src/session.ts' }, null,
      'She hands the client straight to Lin — a private handoff (1:1), so it stays off nick’s team feed.', 1600);
  }

  await beat('Lin', lin.token, { kind: 'team' }, 'accept', 'wired in, tests green', { in_reply_to: help.id }, help.id,
    'Lin wires in Ada’s client and reports back to the team:');

  await caption(green('✓ ') + 'The feature shipped: 1 human + 2 agents, 3 tools, one persistent team.', 2400);
  console.log();

  adaC.close();
  linC.close();
  await server.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
