import { spawn } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as p from '@clack/prompts';
import type { MemberSummary } from '@musterd/protocol';
import pc from 'picocolors';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { claimCommand } from '../commands/claim.js';
import {
  loadConfig,
  rememberIdentity,
  saveBinding,
  saveConfig,
  saveWorkspaceSpec,
  type Config,
} from '../config.js';
import { renderBanner } from '../render/rows.js';
import { inspectInitTarget, nameBoundElsewhere } from './guard.js';
import type { Harness } from './harness.js';
import { HARNESSES } from './harnesses/index.js';
import { writeProvisionManifest } from './manifest.js';
import { buildEntry } from './mcpEntry.js';
import { classifyPrimerTarget, renderPrimer, upsertPrimer } from './primer.js';
import {
  GENERALIST,
  isBuiltin,
  listRoleNames,
  loadRole,
  resolveRoleLabel,
  type RoleTemplate,
} from './role.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Is the cached team+token still valid on this daemon? An authenticated inbox probe fails (caught)
 * when the team no longer exists (db reset) or the token is stale (minted against another db) — so
 * init can avoid offering a dead "reuse" option and fall back to creating a team. (Dogfood: ADR 016.)
 */
export async function cachedTeamLive(server: string, team: string, key: string): Promise<boolean> {
  return new HttpClient({ server, key })
    .inbox(team, { limit: 1 })
    .then(() => true)
    .catch(() => false);
}

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
    process.stderr.write(
      'musterd init is interactive — run it in a terminal (or use `musterd team add` directly).\n',
    );
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
    const start = guard(
      await p.confirm({ message: 'Start the local daemon now? (runs in the background)' }),
    );
    if (!start) {
      p.note(
        `Run ${pc.yellow('musterd serve')} in another terminal, then re-run init.`,
        'Need the daemon',
      );
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

  // 1b) Folder-suitability guard (ADR 020) ----------------------------------
  // Before minting a member / writing a binding / appending a primer, surface a confirm if this
  // folder looks like the wrong place (the musterd source tree, an already-bound folder). Warn,
  // don't block — the happy path is one extra keystroke. (An unrelated AGENTS.md is handled
  // in-context at the primer step, §5b, not warned here — 2026-06-23 dogfood.)
  if (!(await confirmInitTarget())) return 0;

  // 2) Team -----------------------------------------------------------------
  let team: string;
  let creatorToken: string;
  const existing = config.current && config.identities[config.current];
  // Only offer to reuse the cached team if it's actually live on *this* daemon. A wiped/replaced db
  // or a different server makes the saved team+token stale; offering it would fail mid-flow (the
  // db-mismatch dogfood class). Probe with an authenticated call so init stays the single entry point.
  const cachedLive = existing
    ? await cachedTeamLive(server, config.current!, config.identities[config.current!]!.key)
    : false;
  if (existing && cachedLive) {
    p.log.info(
      pc.dim(
        'A team is a standing roster, not a project — reuse the same team across folders to keep agents talking.',
      ),
    );
    const reuse = guard(
      await p.select({
        message: 'Which team?',
        options: [
          {
            value: config.current!,
            label: config.current!,
            hint: `you are ${config.identities[config.current!]!.name}`,
          },
          { value: '__new__', label: 'Create a new team' },
        ],
      }),
    );
    if (reuse === '__new__') {
      ({ team, creatorToken } = await createTeam(config, server));
    } else {
      team = config.current!;
      creatorToken = config.identities[team]!.key;
    }
  } else {
    if (existing && !cachedLive) {
      p.log.warn(
        pc.yellow(
          `Your saved team "${config.current}" isn't on this daemon (its database was reset or you're pointed at a different server) — let's set one up.`,
        ),
      );
    }
    ({ team, creatorToken } = await createTeam(config, server));
  }
  config = loadConfig();
  const http = new HttpClient({ server, key: creatorToken });

  // 2b) Intent — what are you here to do? -----------------------------------
  // Lead with intent, not jargon: the three real first-run postures (dynamics §1–2).
  const intent = guard(
    await p.select({
      message: `What would you like to do on ${pc.bold(team)}?`,
      options: [
        { value: 'new', label: 'Add a new agent', hint: 'connect a coding agent as a teammate' },
        {
          value: 'existing',
          label: 'Activate an existing member',
          hint: 'reconnect a member that is not currently live',
        },
        {
          value: 'watch',
          label: 'Just me — watch the team live',
          hint: 'be present and supervise',
        },
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
    // The request/approval lane (ADR 077) is what "reconnect somewhere new" actually needs, and it's
    // built: `musterd claim <name>` already opens a request when the seat is held elsewhere and waits
    // for an admin to approve it (`musterd requests decide <id> --approve`) instead of dead-ending.
    // This drives that same command rather than duplicating its clobber-guard / wait / binding logic.
    const target = guard(
      await p.text({
        message: 'Which member do you want to reactivate?',
        placeholder: 'Ada',
        validate: (v) => (v && v.trim() ? undefined : 'name the member to reactivate'),
      }),
    ).trim();

    p.log.info(
      pc.dim(
        `Asking ${team} for ${pc.cyan(target)}'s seat — if it's held elsewhere, an admin needs to ` +
          `approve it (${pc.yellow('musterd requests decide <id> --approve')}) while this waits.`,
      ),
    );
    try {
      await claimCommand(
        parseArgs([
          target,
          '--team',
          team,
          '--server',
          server,
          ...(config.agentKeys[team] ? ['--key', config.agentKeys[team]!] : []),
          '--timeout',
          '90',
        ]),
      );
      p.outro(pc.yellow(`${target} is reactivated on ${team} — this folder is bound to it now.`));
    } catch (err) {
      p.log.error(pc.red(err instanceof Error ? err.message : String(err)));
      p.outro(pc.yellow(`Couldn't reactivate ${target} on ${team}.`));
    }
    return 0;
  }

  // 3) Pick where the agent runs --------------------------------------------
  const sd = p.spinner();
  sd.start('Looking for where agents can run');
  const detected = await Promise.all(HARNESSES.map(async (h) => ({ h, d: await h.detect() })));
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
      'Found nowhere to run an agent (looked for Claude Code, Cursor, and Codex).\n' +
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
        hint: d.configured
          ? 'musterd already set up here — will be repointed'
          : 'not set up yet — will be configured',
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

  // 4) Name the agent + choose its role -------------------------------------
  const name =
    guard(
      await p.text({
        message: 'Name your agent',
        placeholder: 'Ada',
        defaultValue: 'Ada',
        validate: (v) => (v && /\s/.test(v) ? 'no spaces in a member name' : undefined),
      }),
    ).trim() || 'Ada';

  // The role template is chosen *before* the member is minted, so the roster/primer role label is
  // derived from it — the label you see matches the tools the agent gets (ADR 038). A non-generalist
  // pick offers an explicit override; generalist/no-template falls back to a free-text label as
  // before. Provisioning the template's tools happens later (§5a), once the harness is wired.
  const template = await selectRole(name);
  const role = resolveRoleLabel({ template, freeText: await askRoleLabel(template) });

  // 4b) Cross-folder name-reuse guard (ADR 020) -----------------------------
  // The name is known now, so this is where the registry check belongs (the early folder guard
  // runs before naming). Warn, don't block — default-yes, same as the folder guard.
  if (!(await confirmNameReuse(name, team, config))) return 0;

  // 5) Mint the member + write the harness config ---------------------------
  const sm = p.spinner();
  sm.start(`Adding ${name} to ${team}`);
  try {
    // v0.3 (ADR 075): declaring the seat is enough — the agent claims it with the team agent key,
    // so there's no per-seat token to capture here anymore.
    await http.addMember(team, { name, kind: 'agent', role });
    sm.stop(`${pc.cyan(name)} is a member of ${pc.bold(team)}`);
  } catch (err) {
    sm.stop(pc.red(`Could not add ${name}: ${(err as Error).message}`));
    return 1;
  }

  // Stamp the folder's claim policy alongside the minted identity (claim-on-first-use, ADR 032):
  // `init` mints the primary seat as before (back-compat), but also records `seat:<name>` so a
  // re-launched session re-occupies it and the claim-on-first-use path is available without re-init.
  // v0.3 (ADR 075): the adapter env authenticates with the team agent key (captured at create) + the
  // seat claim, not a per-seat token. `token` from the mint above is vestigial under the cutover.
  const agentKey = config.agentKeys[team] ?? process.env['MUSTERD_AGENT_KEY'] ?? '';
  const binding = {
    server,
    team,
    agent_key: agentKey,
    surface: chosen.surface,
    claim: { mode: 'seat' as const, name },
  };
  const entry = buildEntry(binding);

  // ADR 018: write the workspace binding — the single file both the CLI and the MCP adapter read,
  // so an agent that shells out to `musterd` resolves to *this* member (not the global config's
  // single shared slot). It carries a token, so warn + offer to gitignore it.
  try {
    const bindingPath = saveBinding(process.cwd(), binding);
    await warnSecretConfig(bindingPath);
  } catch (err) {
    p.log.warn(`Couldn't write .musterd/binding.json (${(err as Error).message}).`);
  }

  // Also write the secret-free committed launch spec (ADR: committed launch spec) — unlike the
  // gitignored binding.json, `.musterd/workspace.json` is safe to commit, so `git add`ing it lets a
  // fresh clone/worktree self-wire the MCP server with `musterd wire` (no interactive init). The key
  // stays out of it; the machine supplies it.
  try {
    saveWorkspaceSpec(process.cwd(), {
      server,
      team,
      surface: chosen.surface,
      claim: { mode: 'seat', name },
    });
    p.log.info(
      pc.dim(
        `Wrote .musterd/workspace.json (no secrets) — ${pc.yellow('git add .musterd/workspace.json')} so a fresh clone can \`musterd wire\` itself.`,
      ),
    );
  } catch (err) {
    p.log.warn(`Couldn't write .musterd/workspace.json (${(err as Error).message}).`);
  }

  // Explicit activation (M3): the agent is dormant until it joins. Offer one-keystroke auto-join
  // on launch for the common solo case; either way a second session as this member is refused cleanly.
  const autojoin = guard(
    await p.confirm({
      message: `Have ${pc.cyan(name)} join the team automatically on launch? ${pc.dim('(otherwise it stays offline until it joins on its own)')}`,
      initialValue: true,
    }),
  );
  if (autojoin) entry.env['MUSTERD_AUTOJOIN'] = '1';

  // Driver co-presence (ADR 021): the operator running init is the human who will drive this agent,
  // so bake their name into the agent's MCP env. The adapter sends it on `hello` and the roster
  // renders `driven by <name>` instead of showing the driving human offline. Best-effort: only when
  // a saved operator identity exists; the human can always override via `MUSTERD_DRIVER`.
  const driver = config.current ? config.identities[config.current]?.name?.trim() : undefined;
  if (driver) entry.env['MUSTERD_DRIVER'] = driver;

  const write = guard(
    await p.confirm({
      message: `Connect musterd to ${pc.bold(chosen.label)} now? ${pc.dim('(adds the musterd tools so the agent can reach the team)')}`,
    }),
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

  // 5a) Provision the chosen role's tools (ADR 026 Universe-2; additive/reversible/local per ADR 027)
  // The template was picked in §4 (and already drove the roster label); now that the musterd server
  // is wired, provision its MCP servers into this harness and pull its charter into the primer.
  // `generalist`/no template provisions nothing extra — only the musterd server + the standard
  // playbook (ADR 028). This is Universe-2 only; identity (the role label) was set at mint.
  const charter = await provisionRoleTools(chosen, template);

  // 5b) Seed the agent primer so the agent knows the team working-loop (ADR 012) ----------
  // The prompt is honest about what writing does *at the decision point*: against an existing,
  // unmarked AGENTS.md the primer is appended (your content is kept), not overwritten — saying
  // "Write an AGENTS.md?" there reads like a clobber (2026-06-18 dogfood).
  const primerTarget = classifyPrimerTarget(process.cwd());
  const primerPrompt =
    primerTarget === 'unmarked'
      ? `Append a musterd primer to the ${pc.bold('AGENTS.md')} already here? ${pc.dim('(your content is kept — the block goes at the end)')}`
      : primerTarget === 'managed'
        ? `Update the musterd primer in this folder's ${pc.bold('AGENTS.md')}?`
        : `Write an ${pc.bold('AGENTS.md')} primer so ${pc.cyan(name)} knows how to use musterd?`;
  const writePrimer = guard(await p.confirm({ message: primerPrompt, initialValue: true }));
  if (writePrimer) {
    try {
      const { path, action } = upsertPrimer(
        process.cwd(),
        renderPrimer({ member: name, team, role, ...(charter ? { charter } : {}) }),
      );
      const verb =
        action === 'created' ? 'Wrote' : action === 'appended' ? 'Added the primer to' : 'Updated';
      p.log.success(
        `${verb} ${pc.bold('AGENTS.md')} ${pc.dim(`(${path})`)} — ${pc.cyan(name)} now has the team playbook.`,
      );
    } catch (err) {
      p.log.warn(
        `Couldn't write AGENTS.md (${(err as Error).message}) — paste the primer from \`musterd init\`'s manual output if you want it.`,
      );
    }
  }

  // 6) Wait for the agent to actually join ----------------------------------
  p.log.info(`${pc.bold('Next:')} ${activation}.`);
  p.log.info(
    autojoin
      ? `${pc.cyan(name)} joins the team automatically on launch.`
      : `In the session, just ask ${pc.cyan(name)} to join the team. ${pc.dim('(behind the scenes it calls the team_join tool)')}`,
  );
  const sw = p.spinner();
  sw.start(`Waiting for ${name} to join`);
  const joined = await waitForPresence(http, team, name, 180);
  if (joined) {
    sw.stop(
      `${pc.green('●')} ${pc.cyan(name)} is online via ${chosen.surface} ${pc.green('— it worked!')}`,
    );
  } else {
    sw.stop(pc.yellow(`Still waiting on ${name}.`));
    p.note(
      (autojoin
        ? `When you start ${chosen.label}, ${name} joins automatically.\n`
        : `Start ${chosen.label} and ask ${name} to join the team.\n`) +
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

async function createTeam(
  config: Config,
  server: string,
): Promise<{ team: string; creatorToken: string }> {
  const slug = guard(
    await p.text({
      message: 'Name your team',
      placeholder: 'dawn',
      defaultValue: 'dawn',
      validate: (v) =>
        /^[a-z0-9-]{1,32}$/.test(v) ? undefined : 'use lowercase letters, numbers, hyphens (1–32)',
    }),
  );
  const you = guard(
    await p.text({
      message: 'Your name on the team',
      placeholder: 'nick',
      defaultValue: process.env['USER'] ?? 'me',
    }),
  ).trim();
  const role = guard(
    await p.text({ message: 'Your role (optional)', placeholder: 'lead', defaultValue: '' }),
  ).trim();

  const http = new HttpClient({ server });
  const sp = p.spinner();
  sp.start(`Creating ${slug}`);
  try {
    const res = await http.createTeam(slug, { name: you, ...(role ? { role } : {}) });
    config.server = server;
    config.current = slug;
    // v0.3 (ADR 075): the creator authenticates with their human credential (mscr_); the team agent
    // key (mskey_) is captured for provisioning agents. Both from the composite mint (SPEC A.7).
    const credential = res.human_credential as string;
    config.agentKeys[slug] = res.agent_key as string;
    config.identities[slug] = { name: you, key: credential, surface: 'cli' };
    rememberIdentity(config, { team: slug, name: you, key: credential, surface: 'cli' }); // ADR 059 vault
    saveConfig(config);
    sp.stop(`Team ${pc.bold(slug)} created — you joined as ${pc.magenta(you)}`);
    return { team: slug, creatorToken: res.token as string };
  } catch (err) {
    sp.stop(pc.red(`Could not create team: ${(err as Error).message}`));
    bail();
  }
}

async function waitForPresence(
  http: HttpClient,
  team: string,
  name: string,
  seconds: number,
): Promise<boolean> {
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
 * Step 4 — pick the role template *before* the member is minted (ADR 038). Lists the built-in seed
 * library plus any `.musterd/roles/*.json`; `generalist` is the default and means "no template"
 * (returns undefined). For a richer pick the template is loaded and returned so its `role` can drive
 * the roster/primer label (via {@link resolveRoleLabel}) and its tools can be provisioned later
 * (§5a). A load failure degrades to no-template (warn, return undefined) so init never wedges here.
 */
async function selectRole(member: string): Promise<RoleTemplate | undefined> {
  const names = listRoleNames(process.cwd());
  const pick = guard(
    await p.select({
      message: `Provision a role for ${pc.cyan(member)}? ${pc.dim('(adds tools + a charter; generalist adds nothing extra)')}`,
      options: names.map((n) => ({
        value: n,
        label: n,
        hint:
          n === GENERALIST
            ? 'nothing extra — just the musterd tools'
            : isBuiltin(n)
              ? 'built-in role'
              : 'from .musterd/roles/',
      })),
    }),
  );
  if (pick === GENERALIST) return undefined;
  try {
    return loadRole(process.cwd(), pick);
  } catch (err) {
    p.log.warn(`Couldn't load role "${pick}" (${(err as Error).message}) — skipping provisioning.`);
    return undefined;
  }
}

/**
 * The free-text side of the role label (ADR 038, Decision #2). With **no template** (generalist /
 * unloadable) it's the same optional free-text prompt as before. With a **template** the label is
 * already settled to `template.role`, so we only offer an explicit *override gate* (default: keep);
 * accepting it opens the free-text prompt. Returns the raw free text (or undefined when the template
 * label is kept) — {@link resolveRoleLabel} applies the precedence.
 */
async function askRoleLabel(template: RoleTemplate | undefined): Promise<string | undefined> {
  if (!template) {
    return guard(
      await p.text({ message: 'Role (optional)', placeholder: 'backend', defaultValue: '' }),
    ).trim();
  }
  const override = guard(
    await p.confirm({
      message: `Override the role label ${pc.bold(template.role)}? ${pc.dim('(it matches the tools you chose — default keeps it)')}`,
      initialValue: false,
    }),
  );
  if (!override) return undefined;
  return guard(
    await p.text({ message: 'Role label', placeholder: template.role, defaultValue: '' }),
  ).trim();
}

/**
 * Step 5a — provision the already-chosen template's tools (ADR 026 §3, provisioning-recipe.md).
 * Provisions its MCP servers into the chosen harness (additive/local — ADR 027), records what was
 * added in the uninstall manifest (ADR 030), and returns the role's charter so the primer step can
 * inject it. No template → nothing to do. A harness without a provision renderer degrades to
 * charter-only. Best-effort: a provisioning hiccup never fails init. Returns the charter, if any.
 */
function hasPermissions(p: { allow: string[]; ask: string[]; deny: string[] }): boolean {
  return p.allow.length + p.ask.length + p.deny.length > 0;
}

async function provisionRoleTools(
  harness: Harness,
  role: RoleTemplate | undefined,
): Promise<string | undefined> {
  if (!role) return undefined;

  const { mcp_servers: servers, permissions } = role.tools;
  if (servers.length === 0 && !hasPermissions(permissions)) {
    p.log.info(pc.dim(`${role.role} adds no tools — applying its charter only.`));
    return role.charter;
  }
  if (!harness.provision) {
    p.log.warn(
      `Tool provisioning isn't supported for ${harness.label} yet — applying ${role.role}'s charter only.`,
    );
    return role.charter;
  }

  const sp = p.spinner();
  sp.start(`Provisioning ${role.role} tools into ${harness.label}`);
  try {
    const result = await harness.provision({ servers, permissions }, 'local');
    const permCount =
      result.permissions.allow.length +
      result.permissions.ask.length +
      result.permissions.deny.length;
    sp.stop(
      `Provisioned ${result.servers.length} MCP server${result.servers.length === 1 ? '' : 's'}` +
        (result.servers.length ? `: ${pc.cyan(result.servers.join(', '))}` : '') +
        (permCount ? ` + ${permCount} permission${permCount === 1 ? '' : 's'}` : '') +
        ` ${pc.dim(`(${result.target})`)}`,
    );
    try {
      writeProvisionManifest(process.cwd(), {
        role: role.role,
        harness: harness.id,
        mcpServers: result.servers,
        permissions: result.permissions,
      });
    } catch (err) {
      p.log.warn(`Couldn't record the provisioning manifest (${(err as Error).message}).`);
    }
    p.log.info(
      pc.dim(
        'Tooling is provisioned additively and per-user/local — a future `musterd uninstall` removes exactly these. Provisioning is a starting point, not a sandbox.',
      ),
    );
  } catch (err) {
    sp.stop(pc.yellow(`Couldn't provision ${role.role} tools: ${(err as Error).message}`));
  }
  return role.charter;
}

/**
 * Folder-suitability guard (ADR 020). If the target folder looks wrong — the musterd source tree
 * or already bound to a member — warn and ask before init mints a
 * member / writes a binding / appends a primer. Default-allow (guard, not block): the user can
 * accept and run anywhere they genuinely mean to, including this repo for dogfooding. Best-effort:
 * a guard failure never blocks a genuine run. Returns false only when the user declines.
 */
async function confirmInitTarget(): Promise<boolean> {
  let warnings: string[] = [];
  try {
    warnings = inspectInitTarget(process.cwd()).warnings;
  } catch {
    return true;
  }
  if (warnings.length === 0) return true;
  for (const w of warnings) p.log.warn(pc.yellow(w));
  const go = guard(
    await p.confirm({ message: 'Set up an agent in this folder anyway?', initialValue: true }),
  );
  if (!go) {
    p.outro(pc.yellow('No changes made — re-run `musterd init` in the project folder you mean.'));
  }
  return go;
}

/**
 * Cross-folder name-reuse guard (ADR 020). If the chosen name is already bound in *another* folder
 * (per the global registry), warn — running here too means two folders driving one member, and on
 * the same team the mint will be refused outright (names are unique per team). Default-allow and
 * best-effort, like {@link confirmInitTarget}. Returns false only when the user declines.
 */
async function confirmNameReuse(name: string, team: string, config: Config): Promise<boolean> {
  let hit: { folder: string; team: string } | null = null;
  try {
    hit = nameBoundElsewhere(name, process.cwd(), config.bindings);
  } catch {
    return true;
  }
  if (!hit) return true;
  p.log.warn(
    pc.yellow(
      `${pc.bold(name)} is already bound in ${pc.dim(hit.folder)} (team ${hit.team}). ` +
        `Setting up here makes a second folder drive that name` +
        (hit.team === team
          ? ' — and the mint will be refused, since names are unique per team.'
          : '.'),
    ),
  );
  const go = guard(await p.confirm({ message: 'Use this name here anyway?', initialValue: true }));
  if (!go) p.outro(pc.yellow('No changes made — pick another name or run in the bound folder.'));
  return go;
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
    p.log.info(
      pc.dim(`No .gitignore here — if this folder is a git repo, add a line ignoring ${rel}.`),
    );
    return;
  }
  const body = readFileSync(gitignore, 'utf8');
  const lines = body.split('\n').map((l) => l.trim());
  if (lines.includes(rel) || lines.includes(`/${rel}`)) {
    p.log.info(pc.dim(`Already ignored by .gitignore — you're covered.`));
    return;
  }
  const add = guard(
    await p.confirm({
      message: `Add ${pc.yellow(rel)} to .gitignore so the token isn't committed?`,
      initialValue: true,
    }),
  );
  if (!add) return;
  const prefix = body.length && !body.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignore, `${prefix}\n# musterd — contains a member token\n${rel}\n`);
  p.log.success(`Added ${pc.yellow(rel)} to .gitignore.`);
}

function printManual(
  harness: Harness,
  entry: { command: string; args: string[]; env: Record<string, string> },
): string {
  const envLines = Object.entries(entry.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join('\n');
  // Also surface the primer so the manual path isn't worse off — the agent still needs to know the playbook.
  const primer = renderPrimer({
    member: entry.env['MUSTERD_MEMBER'] ?? 'your agent',
    team: entry.env['MUSTERD_TEAM'] ?? 'your team',
  });
  const primerNote = `\n\nThen add this to ${pc.bold('AGENTS.md')} in this folder so the agent knows the playbook:\n${primer}`;
  if (harness.id === 'claude-code') {
    const e = Object.entries(entry.env)
      .map(([k, v]) => `-e ${k}=${v}`)
      .join(' ');
    return `Run:\n  claude mcp add musterd -s local ${e} -- ${entry.command} ${entry.args.join(' ')}${primerNote}`;
  }
  if (harness.id === 'codex') {
    return `Add to .codex/config.toml (this folder must be a trusted Codex project):\n  [mcp_servers.musterd]\n  command = "${entry.command}"\n  args = ${JSON.stringify(entry.args)}\n  [mcp_servers.musterd.env]\n${envLines}${primerNote}`;
  }
  return `Add to .cursor/mcp.json under "mcpServers":\n  "musterd": {\n    "command": "${entry.command}",\n    "args": ${JSON.stringify(entry.args)},\n    "env": { …see below… }\n  }\n${envLines}${primerNote}`;
}
