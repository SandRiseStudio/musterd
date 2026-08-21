import { spawn } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as p from '@clack/prompts';
import { type MemberSummary, resolveAttestedModel } from '@musterd/protocol';
// The live, toggle-aware color view (honors --no-color) in place of a pinned picocolors import.
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { claimCommand } from '../commands/claim.js';
import {
  findBinding,
  findWorkspaceSpec,
  loadConfig,
  rememberIdentity,
  saveBinding,
  saveConfig,
  saveWorkspaceSpec,
  type Config,
} from '../config.js';
import { renderBanner } from '../render/rows.js';
import { paint as pc, theme } from '../render/theme.js';
import { sym } from '../render/ui.js';
import { inspectInitTarget, nameBoundElsewhere } from './guard.js';
import { CANONICAL_SKILL_PATH, establishedHarnesses, writeGuidance } from './guidance.js';
import type { Harness } from './harness.js';
import { HARNESSES, harnessAdapters } from './harnesses/index.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';
import { buildEntry } from './mcpEntry.js';
import { installSeatPermissions } from './permissions.js';
import { classifyPrimerTarget, renderPrimer, upsertPrimer } from './primer.js';
import { GENERALIST, isBuiltin, listProfileNames, loadProfile, type Profile } from './profile.js';
import { defaultHarnessContext } from './reconcile/context.js';
import { reconcileHarnesses } from './reconcile/engine.js';

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

/**
 * The team this folder already belongs to (ADR 161), from its own `.musterd/` — the gitignored
 * binding first, the committed workspace spec as fallback (a fresh clone knows its team before it
 * has a credential). Null when the folder is unbound, which is init's genuine first-run case.
 */
function folderTeamHere(dir: string = process.cwd()): string | null {
  return findBinding(dir)?.team ?? findWorkspaceSpec(dir)?.team ?? null;
}

/**
 * What this machine can authenticate to for `team` — **the vault (ADR 059), not the single-slot
 * cache**.
 *
 * `config.identities` holds exactly one identity *per team*, and only for teams this machine has
 * most recently acted on; `config.knownIdentities` is the superset that another team's join cannot
 * evict. Reading only the former is why init could stand in a folder whose binding plainly named a
 * live team, hold a perfectly good credential for it in the vault, and still conclude it had none —
 * routing the operator at "create a new team", the one option that repoints the folder (ADR 161's
 * failure, one layer down). The multi-team case is first-class (install-topology §3); the lookup
 * has to be too.
 */
function credentialFor(config: Config, team: string): { name: string; key: string } | undefined {
  const active = config.identities[team];
  if (active?.key) return { name: active.name, key: active.key };
  const known = config.knownIdentities.find((i) => i.team === team && i.key);
  return known ? { name: known.name, key: known.key } : undefined;
}

/**
 * Every team this machine holds a credential for, most-relevant first: the folder's own team (ADR
 * 161 — it outranks everything), then the last-used one, then the rest of the vault. Deduped by
 * slug, because a team appears in both `identities` and `knownIdentities` by design.
 */
/**
 * The reusable-team rows for init's picker: every live team this machine can authenticate to,
 * excluding any already listed above (the folder's own team gets its own first row). Each says WHO
 * you would be on it — with several teams offered, "which one" is really "which me", and the vault
 * is the only thing that knows.
 */
function teamOptions(
  config: Config,
  liveTeams: string[],
  exclude: string[],
): { value: string; label: string; hint: string }[] {
  return liveTeams
    .filter((slug) => !exclude.includes(slug))
    .map((slug) => ({
      value: slug,
      label: slug,
      hint:
        slug === config.current
          ? `you are ${credentialFor(config, slug)!.name} · last used here`
          : `you are ${credentialFor(config, slug)!.name}`,
    }));
}

function candidateTeams(config: Config, folderTeam: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of [
    ...(folderTeam ? [folderTeam] : []),
    ...(config.current ? [config.current] : []),
    ...config.knownIdentities.map((i) => i.team),
  ]) {
    if (seen.has(slug) || !credentialFor(config, slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * `musterd init --refresh-guidance` (ADR 161): rewrite the stamped skill/command files and nothing
 * else. No team resolution, no member mint, no binding write, no MCP entry — so it is safe in a
 * live seat's worktree, which plain `init` is not. This exists because the doctor's guidance-drift
 * line used to say "run `musterd init`", pointing at the one command that also re-mints identity:
 * a cosmetic version bump should never route a human through an identity-rewriting flow.
 */
export function runRefreshGuidance(dir: string = process.cwd()): number {
  const team = folderTeamHere(dir);
  if (!team) {
    process.stderr.write(
      `${theme.warn(sym.warn)} no musterd binding here — run \`musterd init\` to set this folder up first\n`,
    );
    return 1;
  }
  // Refresh only the harnesses this folder already carries guidance for; adding a harness's files
  // is provisioning, which is `init`'s job, not a refresh's. Shared with the doctor's expected set
  // (ADR 171) so the two cannot disagree about what this command will write.
  const present = establishedHarnesses(dir, HARNESSES);
  // `writeGuidance` always writes the canonical `.musterd/skill/SKILL.md` — correct for init, wrong
  // here: a folder with no guidance at all would sprout one file from a command that promises only
  // to refresh. Caught live running this in a seat worktree that had never been provisioned. Refuse
  // instead, and name the command that legitimately creates it.
  if (present.length === 0 && !existsSync(join(dir, CANONICAL_SKILL_PATH))) {
    process.stdout.write(
      `${theme.meta('no musterd guidance in this folder to refresh — `musterd init` provisions it')}\n`,
    );
    return 0;
  }
  const res = writeGuidance(dir, present, { team });
  process.stdout.write(
    `${theme.ok(sym.ok)} guidance refreshed to v${res.contentVersion} — ${res.files.length} file(s)\n`,
  );
  for (const f of res.files) process.stdout.write(`  ${theme.meta(f)}\n`);
  if (res.skipped.length > 0) {
    process.stdout.write(
      `${theme.meta(`skipped ${res.skipped.length} user-authored file(s): ${res.skipped.join(', ')}`)}\n`,
    );
  }
  return 0;
}

/**
 * `musterd init --refresh-hooks` (ADR 168): rewrite this folder's musterd hooks and nothing else.
 *
 * The sibling of `--refresh-guidance`, and it exists for the same reason: the doctor's hook-drift
 * lines said "run `musterd init`", pointing at the one command that is interactive, re-mints
 * identity, and re-points the worktree-family MCP entry (ADR 165). A hook that is stale or missing
 * is not an identity problem, so repairing it should not route anyone through an identity flow.
 *
 * This is also the *delivery* mechanism the hook system never had. Measured across the 13 dogfood
 * worktrees on 2026-07-27: the ADR 167 observer was installed in 0 of them and the ADR 150
 * enforcement gate in 2, because a hook added after a seat was provisioned reached it only by
 * re-provisioning. A declared enforcement class was therefore silently a no-op in most seats — it
 * fails open, so nothing broke and nothing complained.
 */
export function runRefreshHooks(dir: string = process.cwd()): number {
  const team = folderTeamHere(dir);
  if (!team) {
    process.stderr.write(
      `${theme.warn(sym.warn)} no musterd binding here — run \`musterd init\` to set this folder up first\n`,
    );
    return 1;
  }
  // Only harnesses this folder is already provisioned for. A refresh updates what is there; a first
  // install is `init`'s job — the same line --refresh-guidance draws.
  const present = HARNESSES.filter((h) => h.refreshHooks?.applies(dir));
  if (present.length === 0) {
    process.stdout.write(
      `${theme.meta('no musterd hooks in this folder to refresh — `musterd init` provisions them')}\n`,
    );
    return 0;
  }
  let refused = 0;
  for (const h of present) {
    const res = h.refreshHooks!.run(dir);
    process.stdout.write(`${theme.ok(sym.ok)} ${h.label} hooks refreshed\n`);
    for (const f of res.files) process.stdout.write(`  ${theme.meta(f)}\n`);
    // A refusal is the ADR 168 downgrade guard firing: a NEWER build wrote the hook we were about to
    // replace. Loud, and non-zero exit — silently "succeeding" while declining to write is the exact
    // failure mode this whole ADR exists to end.
    for (const w of res.warnings) {
      refused++;
      process.stderr.write(`${theme.warn(sym.warn)} ${w}\n`);
    }
  }
  return refused > 0 ? 1 : 0;
}

/**
 * `musterd init --refresh-permissions` (ADR 261 increment 2): write the standard floor into this
 * folder's harness permissions block and nothing else.
 *
 * The third sibling of `--refresh-guidance` and `--refresh-hooks`, and it exists for the delivery
 * reason increment 1 left open: `musterd agent` now provisions a floor into *new* worktrees, but
 * every seat that already existed on 2026-08-13 stays unprovisioned until something repairs it.
 * That is the entire remaining surface of the incident class — ryder's seat was one of them.
 *
 * Floor only, deliberately. A role ceiling is recompiled where the role changes (`role assign`),
 * not by a local repair flag: this command runs in a worktree and cannot know whether the daemon's
 * view of the seat's role is newer than the template it would read. Repair reuses
 * {@link installSeatPermissions}, so what a repair writes and what provisioning writes cannot drift.
 */
export function runRefreshPermissions(dir: string = process.cwd()): number {
  const team = folderTeamHere(dir);
  if (!team) {
    process.stderr.write(
      `${theme.warn(sym.warn)} no musterd binding here — run \`musterd init\` to set this folder up first\n`,
    );
    return 1;
  }
  const added = installSeatPermissions(dir);
  const count = added.allow.length + added.ask.length + added.deny.length;
  if (count === 0) {
    process.stdout.write(
      `${theme.ok(sym.ok)} harness permissions already carry the standard floor — nothing to add\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${theme.ok(sym.ok)} added ${String(count)} permission entr${count === 1 ? 'y' : 'ies'} to the harness layer\n` +
      `  ${theme.meta(join(dir, '.claude', 'settings.local.json'))}\n` +
      `  ${theme.meta('existing entries and hooks were kept — this merges, it never clobbers (ADR 261)')}\n`,
  );
  return 0;
}

/**
 * `musterd init --prune-bindings` (ADR 162): drop registry entries whose folder no longer exists.
 *
 * The ADR 020 registry records where each member is bound, keyed by absolute folder path, and
 * nothing removes an entry when the folder is deleted — `removeBinding` only fires for a deliberate
 * `unbind` in a folder that still exists. So the registry only grows, and every stale row is a
 * candidate false "that name is already bound elsewhere" warning.
 *
 * Credentials are deliberately NOT touched: `identities`/`agentKeys` are the only copy of a minted
 * key, and a team being unreachable right now (daemon down, wrong server) is not evidence it is
 * dead. This prunes what can be re-derived, never what cannot.
 */
export function runPruneBindings(opts: { apply?: boolean } = {}): number {
  const config = loadConfig();
  const stale = Object.keys(config.bindings).filter((folder) => !existsSync(folder));
  const total = Object.keys(config.bindings).length;

  if (stale.length === 0) {
    process.stdout.write(
      `${theme.ok(sym.ok)} binding registry is clean — ${total} entr${total === 1 ? 'y' : 'ies'}, all present\n`,
    );
    return 0;
  }
  const byTeam = new Map<string, number>();
  for (const f of stale) {
    const t = config.bindings[f]?.team ?? '?';
    byTeam.set(t, (byTeam.get(t) ?? 0) + 1);
  }
  const summary = [...byTeam.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ×${n}`)
    .join(', ');

  if (!opts.apply) {
    process.stdout.write(
      `${theme.warn(sym.warn)} ${stale.length} of ${total} registry entr${stale.length === 1 ? 'y names a folder' : 'ies name folders'} that no longer exist${stale.length === 1 ? 's' : ''} (${summary})\n` +
        `${theme.meta('re-run with --apply to remove them; credentials are never touched')}\n`,
    );
    return 0;
  }
  for (const f of stale) delete config.bindings[f];
  saveConfig(config);
  process.stdout.write(
    `${theme.ok(sym.ok)} pruned ${stale.length} stale registry entr${stale.length === 1 ? 'y' : 'ies'} (${summary}) — ${Object.keys(config.bindings).length} left\n`,
  );
  return 0;
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
  // The folder's OWN team outranks the globally-cached one (ADR 161). `config.current` is just the
  // last team this machine touched — in a bound worktree it is routinely something else entirely
  // (a finished experiment's team), and treating it as the primary is what let init offer to CREATE
  // A NEW TEAM while standing in a folder whose binding.json plainly named a live one. Creating a
  // team there mints a new member and repoints a live seat's binding: the loudest possible failure
  // for the quietest possible reason.
  const folderTeam = folderTeamHere();
  const folderKey = folderTeam ? credentialFor(config, folderTeam)?.key : undefined;

  // Probe every team this machine could offer, not just the cached one. A team is only offerable if
  // it is live on *this* daemon — a wiped/replaced db or a different server makes a saved
  // team+credential stale, and offering it would fail mid-flow (the db-mismatch dogfood class). The
  // probes are independent, so they run together rather than serially: one authenticated call each,
  // all to the same local daemon.
  const candidates = candidateTeams(config, folderTeam);
  const liveTeams = (
    await Promise.all(
      candidates.map(async (slug) =>
        (await cachedTeamLive(server, slug, credentialFor(config, slug)!.key)) ? slug : null,
      ),
    )
  ).filter((s): s is string => s !== null);

  const folderLive = Boolean(folderTeam && folderKey && liveTeams.includes(folderTeam));
  const existing = config.current && config.identities[config.current];
  const cachedLive = Boolean(config.current && liveTeams.includes(config.current));

  if (folderTeam && folderLive) {
    // This folder already belongs to a live team — that is the default, and creating a new one is
    // the deliberate alternative rather than the fallback.
    const pick = guard(
      await p.select({
        message: 'Which team?',
        options: [
          { value: folderTeam, label: folderTeam, hint: "this folder's team" },
          ...teamOptions(config, liveTeams, [folderTeam]),
          { value: '__new__', label: 'Create a new team' },
        ],
      }),
    );
    if (pick === '__new__') {
      ({ team, creatorToken } = await createTeam(config, server));
    } else {
      team = pick;
      creatorToken = credentialFor(config, team)!.key;
    }
  } else if (folderTeam && !folderLive) {
    // Bound folder, but no usable credential for its team here (or the team is gone from this
    // daemon). Creating a team would silently repoint this folder, so say what is actually wrong
    // and name the paths that do NOT touch identity.
    p.log.warn(
      pc.yellow(
        `This folder is bound to team "${folderTeam}", but this machine has no working credential ` +
          `for it${folderKey ? ' on this daemon' : ''} — so init cannot set up a member on it here. ` +
          `Creating a new team below would repoint this folder away from "${folderTeam}".`,
      ),
    );
    p.note(
      [
        `${pc.yellow('musterd init --refresh-guidance')}  refresh the skill/command files only (no identity changes)`,
        `${pc.yellow('musterd wire')}                     re-wire the MCP server from this folder's workspace.json`,
        `${pc.yellow('musterd agent <seat> --path .')}    re-mint this seat's binding`,
      ].join('\n'),
      'Safe alternatives',
    );
    const go = guard(
      await p.confirm({
        message: `Create a different team here anyway, repointing this folder away from "${folderTeam}"?`,
        initialValue: false,
      }),
    );
    if (!go) {
      p.outro(pc.yellow('No changes made.'));
      return 0;
    }
    ({ team, creatorToken } = await createTeam(config, server));
  } else if (liveTeams.length > 0) {
    p.log.info(
      pc.dim(
        'A team is a standing roster, not a project — reuse the same team across folders to keep agents talking.',
      ),
    );
    const reuse = guard(
      await p.select({
        message: 'Which team?',
        options: [
          ...teamOptions(config, liveTeams, []),
          { value: '__new__', label: 'Create a new team' },
        ],
      }),
    );
    if (reuse === '__new__') {
      ({ team, creatorToken } = await createTeam(config, server));
    } else {
      team = reuse;
      creatorToken = credentialFor(config, team)!.key;
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
    // Authenticate as the SEAT when this machine knows how to (ADR 059), and only fall back to the
    // shared team key. Handing `agentKeys[team]` to any target is what wrote the dead binding at
    // `/Users/nick/agents` on 2026-07-26: the team key cannot act as a human seat, so the claim
    // succeeded and every request after it 403'd. L1 (#457) now refuses that claim outright, which
    // turns the silent poisoning into a loud failure — but a loud failure is still the wrong answer
    // when the credential that *would* have worked was sitting in the vault the whole time.
    // Preferring the seat's own key is also strictly more correct for agent targets, whose vault
    // entry holds the team key anyway, so nothing legitimate changes shape.
    const seatKey = config.knownIdentities.find(
      (i) => i.team === team && i.name === target && i.key,
    )?.key;
    const key = seatKey ?? config.agentKeys[team];
    try {
      await claimCommand(
        parseArgs([
          target,
          '--team',
          team,
          '--server',
          server,
          ...(key ? ['--key', key] : []),
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

  // The ADR 281 multi-select: any SUBSET of the registry (Claude Code, Cursor, Codex, the native
  // musterd host), chosen once per worktree and machine. Available harnesses start selected;
  // unavailable ones stay selectable as `pending` (the selection survives the install); empty is
  // valid (the seat stays reachable through the native host or a later configure).
  const adapters = harnessAdapters();
  const installedIds = new Set(installed.map((x) => x.h.id));
  const picked = guard(
    await p.multiselect({
      message: 'Which harnesses should launch this agent? (space toggles, enter confirms)',
      options: adapters.map((a) => {
        const legacyHarness = HARNESSES.find((x) => x.id === a.id);
        return {
          value: a.id,
          label: a.id === 'musterd' ? 'musterd (native host)' : (legacyHarness?.label ?? a.id),
          ...(a.id !== 'musterd' && !installedIds.has(a.id)
            ? { hint: 'pending — not installed here' }
            : {}),
        };
      }),
      initialValues: adapters
        .filter((a) => a.id === 'musterd' || installedIds.has(a.id))
        .map((a) => a.id),
      required: false,
    }),
  ) as string[];
  const desired = adapters.map((a) => a.id).filter((id) => picked.includes(id));

  // The primary EXTERNAL harness drives the human-facing bits a set can't (the manual-setup note,
  // the role-tool provisioning target, the activation hint). Fine to be absent: native-only works.
  const chosenEntry = installed.find((x) => desired.includes(x.h.id));
  const chosen = chosenEntry?.h as Harness | undefined;
  if (chosenEntry?.d.configured) {
    // Re-running over an existing binding repoints it at the new member; the old one isn't deleted.
    p.note(
      `${pc.bold(chosenEntry.h.label)} already points at a musterd member here.\n` +
        `Setting up next mints a ${pc.bold('new')} member and repoints ${chosenEntry.h.label} at it — so give it a\n` +
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

  // The profile pick and the role label are independent (ADR 272 inc 2, superseding ADR 038's
  // label-from-template derivation): a profile is workspace configuration and mints no team fact,
  // so the roster label comes only from the free-text prompt. Provisioning the profile's tools
  // happens later (§5a), once the harness is wired.
  const template = await selectProfile(name);
  const role = await askRoleLabel();

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
  // Model attestation (ADR 101): if the shell running init already declares a model (MUSTERD_MODEL, or a
  // pinned ANTHROPIC_MODEL), persist it into binding.json so this seat attests by default rather than
  // rotting to `unknown` (the diversity flag is inert on unattested chains). Only a *declared* value is
  // captured — never a guess; unset stays honestly `unknown` and the `init --check` note fires.
  const model = resolveAttestedModel(process.env);

  // Explicit activation (M3): the agent is dormant until it joins. Offer one-keystroke auto-join
  // on launch for the common solo case; either way a second session as this member is refused cleanly.
  // Asked BEFORE the binding is built because the answer lives there now (ADR 165 inc 2): the harness
  // entry is keyed by repo root and shared across worktrees, so per-worktree join policy may not be
  // baked into it.
  const autojoin = guard(
    await p.confirm({
      message: `Have ${pc.cyan(name)} join the team automatically on launch? ${pc.dim('(otherwise it stays offline until it joins on its own)')}`,
      initialValue: true,
    }),
  );

  // Driver co-presence (ADR 021): the operator running init is the human who will drive this agent,
  // so record their name in the binding (ADR 165 inc 2 — per-worktree, never the shared entry). The
  // adapter sends it on `hello` and the roster renders `driven by <name>` instead of showing the
  // driving human offline. Best-effort: only when a saved operator identity exists; the human can
  // always override via `MUSTERD_DRIVER`.
  const driver = config.current ? config.identities[config.current]?.name?.trim() : undefined;

  const binding = {
    version: 2 as const,
    server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat' as const, name },
    ...(model !== undefined ? { model } : {}),
    ...(autojoin ? { autojoin: true } : {}),
    ...(driver ? { driver } : {}),
  };
  const entry = chosen ? buildEntry(binding) : undefined;

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
      version: 2,
      server,
      team,
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

  // Save the strict v2 selection BEFORE reconciliation (ADR 282): a stop right after this leaves
  // honest intent that the next `musterd wire` resumes. Reconciliation never rewrites desire.
  try {
    saveProvisioning(process.cwd(), {
      version: 2,
      // The provisioned PROFILE (workspace configuration), never the roster label — the two are
      // independent since ADR 272 inc 2.
      profile: template?.profile ?? '',
      desired,
      contributions: {},
      provisionedAt: new Date().toISOString(),
    });
  } catch (err) {
    p.log.warn(`Couldn't write .musterd/provisioned.json (${(err as Error).message}).`);
  }

  const selectionLabel = desired.length > 0 ? desired.join(', ') : 'the native host only';
  const write = guard(
    await p.confirm({
      message: `Wire ${pc.bold(selectionLabel)} now? ${pc.dim('(adds the musterd tools so the agent can reach the team)')}`,
    }),
  );
  if (!write) {
    if (chosen && entry) p.note(printManual(chosen, entry), 'Manual setup');
    p.outro(
      'Configure when ready with `musterd wire` (headless, uses this saved selection), then `musterd inbox --watch`.',
    );
    return 0;
  }

  const sc = p.spinner();
  sc.start(`Wiring ${selectionLabel}`);
  const reconcileCtx = defaultHarnessContext(process.cwd(), process.env, { team });
  const report = await reconcileHarnesses(reconcileCtx, desired, { legacyRepair: false });
  sc.stop(
    report.ok
      ? `Harness set wired ${pc.dim(`(${selectionLabel})`)}`
      : pc.yellow('Wired with warnings — `musterd harness status` has the detail'),
  );
  for (const r of report.results) {
    if (
      r.result !== 'applied' &&
      r.result !== 'unchanged' &&
      r.result !== 'satisfied-unmanaged' &&
      r.result !== 'pending'
    ) {
      p.log.warn(pc.yellow(`${r.harness}: ${r.result}${r.detail ? ` — ${r.detail}` : ''}`));
    }
  }
  if (!report.ok) {
    if (chosen && entry) p.note(printManual(chosen, entry), 'Configure it manually');
    return 1;
  }
  const activation = activationFor(desired);

  // 5a) Provision the chosen profile's tools (ADR 026 Universe-2; additive/reversible/local, ADR 027)
  // The profile was picked in §4; now that the musterd set is wired, provision its MCP servers into
  // the primary external harness. `generalist`/no profile provisions nothing extra — only the
  // musterd server + the standard playbook (ADR 028). Profile MCP-server tools ride this legacy
  // provision path until they are fragment-modeled; the musterd entry/hooks/permissions/guidance
  // are the reconciler's. This is Universe-2 only — nothing here touches the roster.
  if (chosen) await provisionProfileTools(chosen, template);

  // The primer's charter is the ROLE layer's (ADR 272 inc 2): when the label names a role in the
  // team's durable library, its charter rides into the primer. A profile's own charter field is
  // legacy-descriptive and never injected. Best-effort — an older daemon (no roles on the wire) or
  // an unreachable roster degrades to no charter.
  const charter = await teamRoleCharter(http, team, role);

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

  // 5c) The on-demand skill + slash commands (ADR 085) now land as MANAGED FRAGMENTS: the
  // reconciliation above wrote each selected harness's guidance fragment plus the canonical
  // musterd-core skill, fingerprinted and ledger-owned — so uninstall releases exactly these
  // through the same engine, and nothing here re-writes the v2 manifest with a v1 shape.

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
      `${pc.green('●')} ${pc.cyan(name)} is online via ${desired[0] ?? 'musterd'} ${pc.green('— it worked!')}`,
    );
  } else {
    sw.stop(pc.yellow(`Still waiting on ${name}.`));
    const launcher = chosen?.label ?? 'a selected harness';
    p.note(
      (autojoin
        ? `When you start ${launcher}, ${name} joins automatically.\n`
        : `Start ${launcher} and ask ${name} to join the team.\n`) +
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

/** A one-line activation hint for the selected harness set — what to launch to bring the seat up. */
function activationFor(desired: readonly string[]): string {
  const hints: Record<string, string> = {
    'claude-code':
      'in a terminal here, run `claude` (or open this folder in the Claude Code extension)',
    cursor: 'open this folder in Cursor (or reload its window)',
    codex: 'open this folder in Codex (it must be a trusted project)',
    musterd: 'the native musterd host launches it on demand (`musterd host`)',
  };
  const firstExternal = desired.find((id) => id !== 'musterd');
  if (firstExternal && hints[firstExternal]) return hints[firstExternal]!;
  if (desired.includes('musterd')) return hints['musterd']!;
  return 'select a harness with `musterd harness configure`, then `musterd wire`';
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
 * Step 4 — pick the workspace profile *before* the member is minted (ADR 038). Lists the built-in
 * seed library plus any user profiles (`.musterd/profiles/*.json`, legacy `.musterd/roles/*.json`);
 * `generalist` is the default and means "no profile" (returns undefined). For a richer pick the
 * profile is loaded and returned so its tools can be provisioned later (§5a) and its name recorded
 * on the guidance-path manifest. A load failure degrades to no-profile (warn, return undefined) so
 * init never wedges here.
 *
 * It does NOT touch the roster label. ADR 272 severed that: the profile is local setup, the role
 * label is a team fact, and a local file cannot grant one. This comment used to say the name drove
 * the label "via resolveRoleLabel" — the symbol was deleted with the coupling, and the sentence
 * outlived it long enough for ryder to find it while accepting the lane that removed it.
 */
async function selectProfile(member: string): Promise<Profile | undefined> {
  const names = listProfileNames(process.cwd());
  const pick = guard(
    await p.select({
      message: `Provision a profile for ${pc.cyan(member)}? ${pc.dim('(adds tools + a charter; generalist adds nothing extra)')}`,
      options: names.map((n) => ({
        value: n,
        label: n,
        hint:
          n === GENERALIST
            ? 'nothing extra — just the musterd tools'
            : isBuiltin(n)
              ? 'built-in profile'
              : 'user profile',
      })),
    }),
  );
  if (pick === GENERALIST) return undefined;
  try {
    return loadProfile(process.cwd(), pick);
  } catch (err) {
    p.log.warn(
      `Couldn't load profile "${pick}" (${(err as Error).message}) — skipping provisioning.`,
    );
    return undefined;
  }
}

/**
 * The role label is a free-text team fact, independent of the profile pick (ADR 272 inc 2 —
 * ADR 038's label-from-template derivation and its override gate are removed with the coupling
 * they existed for). Labelling stays opt-in (the ADR 028 default-nothing posture): empty = no role.
 */
async function askRoleLabel(): Promise<string> {
  return guard(
    await p.text({ message: 'Role (optional)', placeholder: 'backend', defaultValue: '' }),
  ).trim();
}

/**
 * The charter for `label`, read from the team's durable role library off the daemon roster
 * (ADR 227; ADR 272 inc 2 made this the primer's only charter source). Best-effort: no label, an
 * older daemon without roles on the wire, an unknown label, or an unreachable roster all return
 * undefined — init never wedges on a charter.
 */
async function teamRoleCharter(
  http: {
    roster(slug: string): Promise<{ roles?: Array<{ name: string; charter?: string | null }> }>;
  },
  team: string,
  label: string,
): Promise<string | undefined> {
  if (!label) return undefined;
  try {
    const { roles } = await http.roster(team);
    const charter = roles?.find((r) => r.name === label)?.charter?.trim();
    return charter || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Step 5a — provision the already-chosen profile's tools (ADR 026 §3, provisioning-recipe.md).
 * Provisions its MCP servers into the chosen harness (additive/local — ADR 027) and records what
 * was added in the uninstall manifest (ADR 030). No profile, or a profile with nothing to render,
 * → nothing to do. Best-effort: a provisioning hiccup never fails init. The profile's charter
 * field is NOT applied here — charter is the role layer's (ADR 272 inc 2).
 */
function hasPermissions(p: { allow: string[]; ask: string[]; deny: string[] }): boolean {
  return p.allow.length + p.ask.length + p.deny.length > 0;
}

async function provisionProfileTools(
  harness: Harness,
  profile: Profile | undefined,
): Promise<void> {
  if (!profile) return;

  const { mcp_servers: servers, permissions } = profile.tools;
  if (servers.length === 0 && !hasPermissions(permissions)) {
    p.log.info(pc.dim(`${profile.profile} adds no tools — nothing to provision.`));
    return;
  }
  if (!harness.provision) {
    p.log.warn(
      `Tool provisioning isn't supported for ${harness.label} yet — skipping ${profile.profile}.`,
    );
    return;
  }

  const sp = p.spinner();
  sp.start(`Provisioning ${profile.profile} tools into ${harness.label}`);
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
    // Recorded for exact removal in the v2 manifest's contributions — never the v1 shape, which
    // would clobber the strict v2 file init just saved (ADR 281). Role MCP servers are not yet
    // fragment-modeled, so they ride a plainly-named pseudo-harness key uninstall can consult.
    try {
      const current = loadProvisioning(process.cwd());
      if (current.kind === 'valid' && result.servers.length > 0) {
        saveProvisioning(process.cwd(), {
          ...current.value,
          contributions: {
            ...current.value.contributions,
            'role-tools': result.servers.map((s) => `role-server ${harness.id} ${s}`),
          },
        });
      }
    } catch (err) {
      p.log.warn(`Couldn't record the provisioning manifest (${(err as Error).message}).`);
    }
    p.log.info(
      pc.dim(
        'Tooling is provisioned additively and per-user/local — a future `musterd uninstall` removes exactly these. Provisioning is a starting point, not a sandbox.',
      ),
    );
  } catch (err) {
    sp.stop(pc.yellow(`Couldn't provision ${profile.profile} tools: ${(err as Error).message}`));
  }
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

/**
 * The relative paths in `rels` not already covered by a line in `gitignoreBody` (exact-line match,
 * honoring a leading `/`), de-duplicated and skipping empties / out-of-tree (`..`) paths. Pure — the
 * decision half of {@link offerGitignoreGuidance}, split out so it's unit-testable without prompts.
 */
export function missingGitignoreEntries(gitignoreBody: string, rels: string[]): string[] {
  const present = new Set(gitignoreBody.split('\n').map((l) => l.trim()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rels) {
    if (!r || r.startsWith('..') || present.has(r) || present.has(`/${r}`) || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * Offer to add musterd's just-written **guidance** files (the on-demand skill + slash commands, ADR 085)
 * to `.gitignore`. Unlike the token config ({@link warnSecretConfig}), these carry no secret — but they
 * are regenerated per-workspace by `musterd init` and are personal, so committing them only churns the
 * repo (the shared, committed surface is the AGENTS.md primer). Mirrors the secret path: only acts when a
 * `.gitignore` is present and doesn't already cover them, prompts once (default yes), and appends the
 * missing lines surgically under a comment. `relFiles` are relative to cwd. Best-effort — never throws.
 */

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
