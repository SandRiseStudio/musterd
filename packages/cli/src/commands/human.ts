import { resolve as resolvePath } from 'node:path';
import * as p from '@clack/prompts';
import { type Binding, type MemberSummary } from '@musterd/protocol';
import { gitToplevel } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  defaultTeamHome,
  excludeCredentialFromGit,
  loadConfig,
  readBindingAt,
  recordTeamHome,
  rememberIdentity,
  saveBinding,
  saveConfig,
  type Config,
} from '../config.js';
import { CliError } from '../errors.js';
import { bindingRefusal } from '../onboard/guard.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { hint, success, sym } from '../render/ui.js';

/**
 * `musterd human <name>` — the deliberate mirror of `musterd agent <name>` (install-topology §5).
 * The pair *is* the workspace model: **every member stands in a Workspace of their own** —
 * `~/musterd/<team>/<repo>/<member>` (ADR 447), humans and agents alike.
 *
 * `agent` mints a seat and stands it in an isolated worktree because it writes code. A human needs
 * a place where their *identity resolves*, so `musterd board`, `musterd inbox --watch` and `musterd
 * send` are simply them, with no `--as` and nothing pasted. Before this command there was no such
 * place: eleven agent worktrees on the dogfood machine and zero for the person, whose binding
 * therefore ended up wherever `team create` happened to run — which on that machine was the
 * daemon's own checkout. ADR 176 first gave them the team home `~/musterd/<team>` itself; ADR 447
 * makes that folder the unbound roof over the team's repos (identity walks up, and a binding there
 * would confer the person on every member worktree beneath it), so the person's floor is a member
 * worktree like everyone else's.
 *
 * Everything here is glue over shipped parts (member add, ADR 059 vault, ADR 018 binding, ADR 075
 * claim); the only new state is the `teamHome` config key — the recorded floor.
 *
 * **On `config.current`.** This command sets it, and says so. `current` is a machine-global "last
 * team I touched", and install-topology §3 argues the home is the better answer to *which team am I
 * acting on* — location, not history. But provisioning your floor is the single strongest statement
 * of intent a person can make about a team, and leaving `current` pointed at whatever it named
 * before means a bare `musterd send` from outside any home still acts on the wrong team. So the home
 * takes over the question where you are standing in one, and `current` is dragged into agreement for
 * everywhere else. It is printed, never silent, and re-runs re-assert it — a rule with no exceptions
 * is easier to hold than a conditional one.
 */
export async function humanCommand(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd human <name> [--team <slug>] [--home <dir>] [--role <role>] [--rotate]',
      2,
    );
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) {
    throw new CliError(
      'no team — pass --team <slug>, or create one: musterd team create <slug>',
      2,
    );
  }
  const role = flagStr(parsed.flags, 'role');

  // Deliberately identity-free, exactly like `team credential` (ADR 174): both member-add and
  // credential-rotate sit at the daemon's provisioning bar (localhost unauthenticated, admin
  // credential off-host — ADR 134). Demanding an active identity would be circular for the very
  // person this command exists to serve: their problem *is* that they have no floor to act from.
  const http = new HttpClient({ server, surface: 'cli' });

  const home = resolveHome(config, team, name, flagStr(parsed.flags, 'home'));

  // ── 1. the member ────────────────────────────────────────────────────────────────────────────
  const { members } = await http.roster(team);
  const existing = members.find((m) => m.name === name);
  assertHumanSeat(existing, name, team);

  const held = findHeldCredential(config, team, name);
  let credential: string;
  let minted: 'added' | 'rotated' | null = null;
  if (!existing) {
    const res = (await http.addMember(team, {
      name,
      kind: 'human',
      ...(role ? { role } : {}),
    })) as { human_credential?: string };
    if (!res.human_credential) {
      throw new CliError(
        `the daemon added "${name}" but returned no credential — it may predate the human-credential ` +
          `mint (ADR 069); upgrade it, then re-run`,
        4,
      );
    }
    credential = res.human_credential;
    minted = 'added';
  } else if (held) {
    // Already on the roster and this machine already holds the secret: reuse it and clobber nothing.
    // Idempotency is the point — a second run must be safe to type without thinking about it.
    credential = held.key;
  } else {
    // On the roster, but this machine has no credential for them. `credential_hash` is one column and
    // minting overwrites it, so the only exit is a rotate — which invalidates the old secret wherever
    // else it lives. That is a real consequence for a possibly-absent person, so it is never implicit.
    if (!(await confirmRotate(parsed, name, team))) {
      throw new CliError(
        `"${name}" is already on "${team}" but this machine holds no credential for them.\n` +
          `  re-issuing one invalidates their existing credential wherever it is — confirm with:\n` +
          `    musterd human ${name} --team ${team} --rotate\n` +
          `  or, if you already have the secret: musterd claim ${name} --team ${team} --key <mscr_…>`,
        4,
      );
    }
    const res = await http.rotateCredential(team, name);
    credential = res.credential;
    minted = 'rotated';
  }

  // ── 2. the floor ─────────────────────────────────────────────────────────────────────────────
  // The binding carries the seat's bearer secret in `agent_key` whatever its prefix — for a human
  // folder that is their `mscr_`, the shape `team create` has always written for the creator (and
  // what `gather()` reads). The home just gives it a *designated* place instead of "wherever the
  // command happened to run".
  const binding: Binding = {
    version: 2,
    server,
    team,
    agent_key: credential,
    claim: { mode: 'seat', name },
  };
  saveBinding(home, binding);

  config.server = server;
  config.identities[team] = { name, key: credential, surface: 'cli' };
  rememberIdentity(config, { team, name, key: credential, surface: 'cli' }); // ADR 059 vault
  recordTeamHome(config, team, home);
  const previousTeam = config.current;
  config.current = team;
  saveConfig(config);

  // ── 3. online ────────────────────────────────────────────────────────────────────────────────
  // Self-claim so the roster shows the person immediately rather than at their next command: a
  // credential claiming its own seat is self-authorizing (ADR 077), no grant and no approval lane.
  // Best-effort by design — the floor is written and durable at this point, so a claim that refuses
  // (daemon busy, seat held elsewhere) is worth *reporting*, never worth failing the provision over.
  let claimed: string | null = null;
  let claimError: string | null = null;
  try {
    const outcome = await http.claim(team, {
      key: credential,
      target: { seat: name },
      surface: 'cli',
    });
    if (outcome.state === 'occupied') claimed = outcome.seat.name;
    else if (outcome.state === 'pending')
      claimError = `claim is pending approval (${outcome.requestId})`;
    else claimError = `${outcome.code}: ${outcome.message}`;
  } catch (err) {
    claimError = (err as Error).message;
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        home,
        minted,
        ...(minted ? { credential } : {}),
        ...(held ? { credentialFrom: held.source } : {}),
        online: claimed !== null,
        current: team,
        previousCurrent: previousTeam ?? null,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${minted === 'added' ? 'added' : 'reused'} ${theme.memberName(name, 'human')} ` +
      `${theme.meta(`(human${role ? `, ${role}` : ''})`)} ${minted === 'added' ? 'on' : 'of'} ${team}\n`,
  );
  process.stdout.write(
    `${theme.ok(sym.ok)} Workspace ${home} ${theme.meta('(binding written, 0600)')}\n`,
  );
  // Never silent about the machine-global write — see the note on `config.current` above.
  process.stdout.write(
    `${theme.ok(sym.ok)} current team ${theme.accent(team)} ` +
      theme.meta(
        previousTeam === team
          ? '(unchanged)'
          : `(was ${previousTeam ?? 'unset'}) — ambient commands act on ${team} now`,
      ) +
      '\n',
  );
  if (minted) {
    process.stdout.write(
      theme.meta(
        minted === 'rotated'
          ? 'credential re-issued — the previous one stops working at their next claim. Shown once:'
          : 'their credential (already saved here; shown once in case they need it elsewhere):',
      ) + '\n',
    );
    process.stdout.write(`  ${credential}\n`);
  }
  if (claimed) {
    process.stdout.write(
      `${theme.presenceDot('online')} ${theme.meta(`${claimed} online via cli`)}\n`,
    );
  } else {
    // Honest about the one step that didn't land, and about it being the only one.
    process.stdout.write(
      `${theme.warn(sym.warn)} not online yet ${theme.meta(`(${claimError ?? 'claim refused'})`)} — ` +
        theme.meta('the home is written; any command from it will claim the seat') +
        '\n',
    );
  }
  process.stdout.write(
    success(`${name} stands in ${team}`, { next: `cd ${home} && musterd board` }) + '\n',
  );
  process.stdout.write(hint('watch what arrives: musterd inbox --watch') + '\n');
  return 0;
}

/**
 * Resolve the person's floor: `--home` → the recorded `teamHome[slug]` → a member worktree of the
 * repo the command runs in, at `~/musterd/<team>/<repo>/<name>` (ADR 447; the same placement
 * `musterd agent` uses, minus the seat git identity — the person keeps their own). Outside a repo
 * there is no default: `--home <dir>` names a plain folder. `~/musterd/<team>` itself is never the
 * answer — it is the roof over the team's repos, and a binding there would confer the person on
 * every member worktree beneath it.
 *
 * Refuses when the directory already carries a **different** team's binding — a floor is one team's
 * ground, and silently repointing it would hand this person's credential the last word over
 * somebody else's. Rebinding the same team in place is fine (that is the idempotent re-run).
 */
function resolveHome(config: Config, team: string, name: string, flag: string | undefined): string {
  const explicit = flag ?? config.teamHome[team];
  if (!explicit && !gitToplevel(process.cwd())) {
    throw new CliError(
      `musterd human stands a person in a member worktree, ~/musterd/${team}/<repo>/${name} (ADR 447) — ` +
        `run it inside the project's checkout, or pass --home <dir>`,
      2,
    );
  }
  const dir = explicit
    ? resolvePath(explicit)
    : provisionWorkspace(name, { team, branch: `human/${name}`, gitIdentity: false }).dir;
  const occupant = readBindingAt(dir);
  if (occupant && occupant.team !== team) {
    throw new CliError(
      `${dir} is already the floor of "${occupant.team}" — a floor belongs to one team.\n` +
        `  pick another: musterd human --team ${team} --home ${defaultTeamHome(team)}/<repo>/${name}`,
      2,
    );
  }
  // Never above a Workspace (reach spec §6, ADR 442): `~`, `~/musterd`, a team root, a repo group, a
  // folder with member worktrees beneath — a binding there would confer the human on every unbound
  // folder under it.
  const refusal = bindingRefusal(dir);
  if (refusal) throw new CliError(`musterd human refused: ${refusal.reason}`, 2);
  if (explicit) provisionWorkspace(name, { path: dir, team, gitIdentity: false });
  // Guard the floor the moment it exists, before a credential lands on it. `team export` guards it too,
  // but a home is committable long before anyone exports a roster into it — the binding written just
  // below is already the secret, and the person may well `git init` here first.
  excludeCredentialFromGit(dir);
  return dir;
}

/**
 * Does this machine already hold a credential for `(team, name)`? The vault (ADR 059) is the
 * intended home for one, but it is **not the only place one lands**: before the team home existed, a
 * person's credential went wherever a command was typed — into that folder's binding and nowhere
 * else. On the machine this arc was written for, that is exactly the state: `nick`'s `mscr_` lives in
 * one binding and has no vault entry at all.
 *
 * Looking only in the vault would therefore route the founder into a *destructive rotate* to recover
 * a credential he already has, on the first real run of the command. So the search continues into the
 * ADR 020 binding registry — the machine's own index of where members are bound — and reads the
 * exact folder each entry names.
 *
 * One key is deliberately rejected: the **team agent key**. A human seat's binding carrying an
 * `mskey_` is not a credential this machine holds, it is install-topology §6(a)'s dead binding —
 * occupied once, then 403 on every request. Reusing it would rebuild that bug inside the very
 * command meant to end it, so it reads as "hold nothing" and the rotate is offered honestly.
 */
function findHeldCredential(
  config: Config,
  team: string,
  name: string,
): { key: string; source: 'vault' | 'binding' } | null {
  const agentKey = config.agentKeys[team];
  const usable = (key: string | undefined): key is string =>
    Boolean(key) && key !== agentKey && key !== process.env['MUSTERD_AGENT_KEY'];

  const vault = config.knownIdentities.find((i) => i.team === team && i.name === name);
  if (usable(vault?.key)) return { key: vault.key, source: 'vault' };

  for (const [dir, ref] of Object.entries(config.bindings)) {
    if (ref.team !== team || ref.seat !== name) continue;
    const binding = readBindingAt(dir);
    if (binding?.team === team && usable(binding.agent_key)) {
      return { key: binding.agent_key, source: 'binding' };
    }
  }
  return null;
}

/** A human seat is the only thing this command may stand a person in — never an agent's seat. */
function assertHumanSeat(existing: MemberSummary | undefined, name: string, team: string): void {
  if (existing && existing.kind !== 'human') {
    throw new CliError(
      `"${name}" is already on "${team}" as a ${existing.kind}, not a human — ` +
        `agents stand in worktrees (musterd agent ${name}), not in the team home`,
      2,
    );
  }
}

/** `--rotate` is the non-interactive confirm; a TTY gets asked. Anything else is a refusal. */
async function confirmRotate(parsed: Parsed, name: string, team: string): Promise<boolean> {
  if (parsed.flags['rotate'] === true) return true;
  if (parsed.flags['json'] === true || !process.stdin.isTTY) return false;
  const answer = await p.confirm({
    message: `Re-issue ${name}'s credential for "${team}"? Their existing one stops working.`,
    initialValue: false,
  });
  return answer === true;
}
