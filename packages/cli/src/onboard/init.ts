import { spawn } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { MemberSummary } from '@musterd/protocol';
import { HttpClient } from '../client.js';
import { loadConfig, saveConfig, type Config } from '../config.js';
import { renderBanner } from '../render/rows.js';
import type { Harness } from './harness.js';
import { HARNESSES } from './harnesses/index.js';
import { buildEntry } from './mcpEntry.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bail(): never {
  p.cancel('Onboarding cancelled — run `musterd init` any time.');
  process.exit(130);
}
function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) bail();
  return value as T;
}

async function health(server: string): Promise<boolean> {
  try {
    const res = await fetch(server + '/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawn `musterd serve` detached so it outlives this process, then wait for health. */
async function startDaemon(server: string): Promise<boolean> {
  const child = spawn(process.execPath, [process.argv[1]!, 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (await health(server)) return true;
    await delay(300);
  }
  return false;
}

export async function runInit(): Promise<number> {
  if (!process.stdout.isTTY) {
    process.stderr.write('musterd init is interactive — run it in a terminal (or use `musterd team add` directly).\n');
    return 2;
  }

  console.clear();
  process.stdout.write('\n' + renderBanner() + '\n\n');
  p.intro(pc.bgYellow(pc.black(' musterd init ')));

  let config: Config = loadConfig();
  const server = config.server;

  // 1) Daemon ---------------------------------------------------------------
  const s = p.spinner();
  s.start('Looking for the team server');
  if (await health(server)) {
    s.stop(`Team server is up at ${pc.dim(server)}`);
  } else {
    s.stop(`No team server at ${pc.dim(server)}`);
    const start = guard(await p.confirm({ message: 'Start the local daemon now? (runs in the background)' }));
    if (!start) {
      p.note(`Run ${pc.yellow('musterd serve')} in another terminal, then re-run init.`, 'Need the daemon');
      return 1;
    }
    const s2 = p.spinner();
    s2.start('Starting the daemon');
    const ok = await startDaemon(server);
    if (!ok) {
      s2.stop('Could not reach the daemon');
      return 1;
    }
    s2.stop(`Daemon listening at ${pc.dim(server)}`);
  }

  // 2) Team -----------------------------------------------------------------
  let team: string;
  let creatorToken: string;
  const existing = config.current && config.identities[config.current];
  if (existing) {
    p.log.info(
      pc.dim('A team is a standing roster, not a project — reuse the same team across folders to keep agents talking.'),
    );
    const reuse = guard(
      await p.select({
        message: 'Which team?',
        options: [
          { value: config.current!, label: config.current!, hint: `you are ${config.identities[config.current!]!.name}` },
          { value: '__new__', label: 'Create a new team' },
        ],
      }),
    );
    if (reuse === '__new__') {
      ({ team, creatorToken } = await createTeam(config, server));
    } else {
      team = config.current!;
      creatorToken = config.identities[team]!.token;
    }
  } else {
    ({ team, creatorToken } = await createTeam(config, server));
  }
  config = loadConfig();
  const http = new HttpClient({ server, token: creatorToken });

  // 2b) Intent — what are you here to do? -----------------------------------
  // Lead with intent, not jargon: the three real first-run postures (dynamics §1–2).
  const intent = guard(
    await p.select({
      message: `What would you like to do on ${pc.bold(team)}?`,
      options: [
        { value: 'new', label: 'Add a new agent', hint: 'connect a coding agent as a teammate' },
        { value: 'existing', label: 'Activate an existing member', hint: 'reconnect a member that is not currently live' },
        { value: 'watch', label: 'Just me — watch the team live', hint: 'be present and supervise' },
      ],
    }),
  );

  if (intent === 'watch') {
    // Supervising posture: the human is already a member (joined at team create); nothing to mint.
    p.note(
      `${pc.yellow('musterd inbox --watch')}   be present and watch the team live\n` +
        `${pc.yellow('musterd status')}         see who's online`,
      'You are present',
    );
    p.outro(pc.yellow(`Watching ${team}. Run ${pc.bold('musterd inbox --watch')} when ready.`));
    return 0;
  }

  if (intent === 'existing') {
    // v0.2 down-payment is the framing only; reattaching a member needs its token back, which
    // means the v0.3 seat-claim model (creator-authorized reissue). Surface it honestly, don't fake it.
    p.note(
      `Reconnecting an existing member somewhere new needs the seat-claim model — that lands in ${pc.bold('v0.3')}.\n` +
        `For now, add it as a new agent, or if you still hold its token, set it up manually.`,
      'Coming in v0.3',
    );
    const addNew = guard(
      await p.confirm({ message: 'Add a new agent instead?', initialValue: true }),
    );
    if (!addNew) {
      p.outro(pc.yellow(`No changes made to ${team}.`));
      return 0;
    }
  }

  // 3) Pick where the agent runs --------------------------------------------
  const sd = p.spinner();
  sd.start('Looking for where agents can run');
  const detected = await Promise.all(
    HARNESSES.map(async (h) => ({ h, d: await h.detect() })),
  );
  sd.stop('Scanned for places an agent can run');

  for (const { h, d } of detected) {
    const tag = !d.installed
      ? pc.dim('not installed')
      : d.configured
        ? pc.green('installed · musterd already configured')
        : pc.yellow('installed');
    p.log.step(`${pc.bold(h.label)} ${pc.dim('—')} ${tag}`);
  }

  const installed = detected.filter((x) => x.d.installed);
  if (installed.length === 0) {
    p.note(
      'Found nowhere to run an agent (looked for Claude Code and Cursor).\n' +
        `Add an agent manually with:\n  ${pc.yellow(`musterd team add <name> --kind agent`)}`,
      'Nothing to configure',
    );
    p.outro('Team is ready — agents can join over MCP or the WS API.');
    return 0;
  }

  const harness = guard(
    await p.select({
      message: 'Where does this agent run?',
      options: installed.map(({ h, d }) => ({
        value: h.id,
        label: h.label,
        hint: d.configured ? 'musterd already set up here — will be repointed' : 'not set up yet — will be configured',
      })),
    }),
  );
  const chosenEntry = installed.find((x) => x.h.id === harness)!;
  const chosen = chosenEntry.h as Harness;
  if (chosenEntry.d.configured) {
    // Re-running over an existing binding repoints it at the new member; the old one isn't deleted.
    p.note(
      `${pc.bold(chosen.label)} already points at a musterd member here.\n` +
        `Setting up next mints a ${pc.bold('new')} member and repoints ${chosen.label} at it — so give it a\n` +
        `name not already on the team (a repeat name is refused). The previous member stays on the roster.`,
      'Heads up',
    );
  }

  // 4) Name the agent -------------------------------------------------------
  const name = guard(
    await p.text({
      message: 'Name your agent',
      placeholder: 'Ada',
      defaultValue: 'Ada',
      validate: (v) => (v && /\s/.test(v) ? 'no spaces in a member name' : undefined),
    }),
  ).trim() || 'Ada';
  const role = guard(await p.text({ message: 'Role (optional)', placeholder: 'backend', defaultValue: '' })).trim();

  // 5) Mint the member + write the harness config ---------------------------
  const sm = p.spinner();
  sm.start(`Adding ${name} to ${team}`);
  let token: string;
  try {
    const res = await http.addMember(team, { name, kind: 'agent', role });
    token = res.token as string;
    sm.stop(`${pc.cyan(name)} is a member of ${pc.bold(team)}`);
  } catch (err) {
    sm.stop(pc.red(`Could not add ${name}: ${(err as Error).message}`));
    return 1;
  }

  const binding = { server, team, member: name, token, surface: chosen.surface };
  const entry = buildEntry(binding);

  // Explicit activation (M3): the agent is dormant until it joins. Offer one-keystroke auto-join
  // on launch for the common solo case; either way a second session as this member is refused cleanly.
  const autojoin = guard(
    await p.confirm({
      message: `Auto-join the team when ${pc.cyan(name)} starts? (otherwise the agent joins when it calls team_join)`,
      initialValue: true,
    }),
  );
  if (autojoin) entry.env['MUSTERD_AUTOJOIN'] = '1';

  const write = guard(
    await p.confirm({ message: `Write the musterd MCP server into ${pc.bold(chosen.label)} for you?` }),
  );
  if (!write) {
    p.note(printManual(chosen, entry), 'Manual setup');
    p.outro('Configure that when ready, then `musterd inbox --watch`.');
    return 0;
  }

  const sc = p.spinner();
  sc.start(`Configuring ${chosen.label}`);
  let activation: string;
  try {
    const result = await chosen.configure(entry, binding);
    activation = result.activation;
    sc.stop(`${chosen.label} configured ${pc.dim(`(${result.target})`)}`);
    if (result.scope) p.log.info(pc.dim(result.scope));
    if (result.secretPath) await warnSecretConfig(result.secretPath);
  } catch (err) {
    sc.stop(pc.red(`Could not configure ${chosen.label}: ${(err as Error).message}`));
    p.note(printManual(chosen, entry), 'Configure it manually');
    return 1;
  }

  // 6) Wait for the agent to actually join ----------------------------------
  p.log.info(`${pc.bold('Next:')} ${activation}.`);
  p.log.info(
    autojoin
      ? `${pc.cyan(name)} joins the team automatically on launch.`
      : `In the session, tell ${pc.cyan(name)} to join the team (it calls ${pc.yellow('team_join')}).`,
  );
  const sw = p.spinner();
  sw.start(`Waiting for ${name} to join`);
  const joined = await waitForPresence(http, team, name, 180);
  if (joined) {
    sw.stop(`${pc.green('●')} ${pc.cyan(name)} is online via ${chosen.surface} ${pc.green('— it worked!')}`);
  } else {
    sw.stop(pc.yellow(`Still waiting on ${name}.`));
    p.note(
      (autojoin
        ? `When you start ${chosen.label}, ${name} joins automatically.\n`
        : `Start ${chosen.label} and have ${name} call ${pc.yellow('team_join')}.\n`) +
        `Check any time with ${pc.yellow('musterd status')}.`,
      'No rush',
    );
  }

  p.note(
    `${pc.yellow('musterd inbox --watch')}   be present and watch the team live\n` +
      `${pc.yellow('musterd status')}         see who's online\n` +
      `${pc.yellow('musterd send --to ' + name + ' --act message "hi"')}   talk to your agent`,
    'You are mustered',
  );
  p.outro(pc.yellow('Welcome to your team.'));
  return 0;
}

async function createTeam(config: Config, server: string): Promise<{ team: string; creatorToken: string }> {
  const slug = guard(
    await p.text({
      message: 'Name your team',
      placeholder: 'dawn',
      defaultValue: 'dawn',
      validate: (v) => (/^[a-z0-9-]{1,32}$/.test(v) ? undefined : 'use lowercase letters, numbers, hyphens (1–32)'),
    }),
  );
  const you = guard(
    await p.text({ message: 'Your name on the team', placeholder: 'nick', defaultValue: process.env['USER'] ?? 'me' }),
  ).trim();
  const role = guard(await p.text({ message: 'Your role (optional)', placeholder: 'lead', defaultValue: '' })).trim();

  const http = new HttpClient({ server });
  const sp = p.spinner();
  sp.start(`Creating ${slug}`);
  try {
    const res = await http.createTeam(slug, { name: you, ...(role ? { role } : {}) });
    config.server = server;
    config.current = slug;
    config.identities[slug] = { name: you, token: res.token as string, surface: 'cli' };
    saveConfig(config);
    sp.stop(`Team ${pc.bold(slug)} created — you joined as ${pc.magenta(you)}`);
    return { team: slug, creatorToken: res.token as string };
  } catch (err) {
    sp.stop(pc.red(`Could not create team: ${(err as Error).message}`));
    bail();
  }
}

async function waitForPresence(http: HttpClient, team: string, name: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try {
      const { members } = await http.roster(team);
      const m = members.find((x: MemberSummary) => x.name === name);
      if (m && m.presence !== 'offline') return true;
    } catch {
      // transient; keep waiting
    }
    await delay(1000);
  }
  return false;
}

/**
 * A harness config we just wrote into the working tree carries the member's token in plaintext.
 * Warn, and if there's a `.gitignore` here that doesn't already cover it, offer to add the line —
 * so the token isn't committed. Best-effort: never throws, only nudges.
 */
async function warnSecretConfig(secretPath: string): Promise<void> {
  const rel = relative(process.cwd(), secretPath);
  // Only manage .gitignore for files that actually live under this folder.
  const inTree = rel && !rel.startsWith('..');
  p.log.warn(
    `${pc.yellow(rel || secretPath)} now holds ${pc.bold(`${pc.cyan('this agent')}'s access token`)} in plaintext — don't commit it.`,
  );
  if (!inTree) return;
  const gitignore = join(process.cwd(), '.gitignore');
  if (!existsSync(gitignore)) {
    p.log.info(pc.dim(`No .gitignore here — if this folder is a git repo, add a line ignoring ${rel}.`));
    return;
  }
  const body = readFileSync(gitignore, 'utf8');
  const lines = body.split('\n').map((l) => l.trim());
  if (lines.includes(rel) || lines.includes(`/${rel}`)) {
    p.log.info(pc.dim(`Already ignored by .gitignore — you're covered.`));
    return;
  }
  const add = guard(await p.confirm({ message: `Add ${pc.yellow(rel)} to .gitignore so the token isn't committed?`, initialValue: true }));
  if (!add) return;
  const prefix = body.length && !body.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignore, `${prefix}\n# musterd MCP config — contains a member token\n${rel}\n`);
  p.log.success(`Added ${pc.yellow(rel)} to .gitignore.`);
}

function printManual(harness: Harness, entry: { command: string; args: string[]; env: Record<string, string> }): string {
  const envLines = Object.entries(entry.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join('\n');
  if (harness.id === 'claude-code') {
    const e = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${v}`).join(' ');
    return `Run:\n  claude mcp add musterd -s local ${e} -- ${entry.command} ${entry.args.join(' ')}`;
  }
  return `Add to .cursor/mcp.json under "mcpServers":\n  "musterd": {\n    "command": "${entry.command}",\n    "args": ${JSON.stringify(entry.args)},\n    "env": { …see below… }\n  }\n${envLines}`;
}
