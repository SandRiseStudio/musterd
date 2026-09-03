import { type Binding, resolveAttestedModel } from '@musterd/protocol';
import { flagStr, type Parsed, flagHue } from '../args.js';
import { loadConfig, saveBinding, saveWorkspaceSpec } from '../config.js';
import { CliError } from '../errors.js';
import { infraTouchWarning } from '../infra-gate.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { buildEntry } from '../onboard/mcpEntry.js';
import { installSeatPermissions } from '../onboard/permissions.js';
import { loadToolkit } from '../onboard/toolkit.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { writeSeatFile } from '../roster.js';
import { resolve } from './helpers.js';

/**
 * `musterd agent <name>` — one command to add an agent AND give it an isolated, ready-to-run
 * workspace (ADR 065). It (1) adds/revives the agent member on the team, (2) creates a git worktree
 * (own branch + tree) — a sibling folder outside git — (3) writes that folder's binding, and
 * (4) registers the musterd MCP server there with autojoin, for the chosen harness. Opening a session
 * of that harness in the printed folder then *is* that agent, with no binding thrash against your own
 * seat.
 *
 * `--harness <claude-code|cursor|codex|opencode|grok>` picks the harness to wire (default claude-code) — the same
 * pluggable adapters `musterd init` uses (ADR 038/085), so a Cursor or Codex user gets a genuinely
 * wired workspace, not a Claude-Code-only one. `--here` keeps the legacy single-folder behavior;
 * `--path <dir>` targets an explicit folder.
 */
export async function agentCommand(
  parsed: Parsed,
  deps: {
    /** ADR 227 inc 2: the warn-only infra-touch gate (injected so tests never reach a daemon). */
    infraGate?: (verb: string) => Promise<string | null>;
  } = {},
): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd agent <name> [--role <label>] [--profile <profile>] [--model <id>] [--harness <claude-code|cursor|codex|opencode|grok>] [--driver <you>] [--here | --path <dir>]',
      2,
    );
  }
  // ADR 272 inc 2 — the split: `--role` is the team fact (roster label) and `--profile` is the
  // local setup (workspace provisioning); neither implies the other. Pre-rename, one flag did both.
  const role = flagStr(parsed.flags, 'role');
  const profileName = flagStr(parsed.flags, 'profile');
  // ADR 374: the seat's colour, if the creator chose one; otherwise assigned at write (file-backed)
  // or by the daemon (db-only). Validated first so a typo touches nothing.
  const hue = flagHue(parsed.flags);
  // Model attestation (ADR 101): persist a *declared* model into the seat's binding.json so the adapter
  // attests by default instead of rotting to `unknown`. `--model` wins, else the ambient env the CLI
  // runs in (MUSTERD_MODEL / ANTHROPIC_MODEL, via the shared resolver). Never a guess — undefined stays
  // honestly `unknown` (warn-never-block); the `init --check` note catches an unattested live seat.
  const model = flagStr(parsed.flags, 'model') ?? resolveAttestedModel(process.env);

  // Driver co-presence (ADR 021, activated by ADR 155 Inc 1): opt-in per workspace. `--driver <you>`
  // writes `driver` into the seat's binding.json so the adapter reports who is steering — which makes
  // the steering human read `working`/present on the roster instead of offline. `--driver` bare uses
  // the acting identity (`--as`). Absent = no driver (unchanged, warn-never-block): presence is a
  // convenience the operator grants, never inferred behind their back.
  let driver: string | undefined;
  const driverFlag = parsed.flags['driver'];
  if (typeof driverFlag === 'string' && driverFlag.trim()) {
    driver = driverFlag.trim();
  } else if (driverFlag === true) {
    driver = flagStr(parsed.flags, 'as');
    if (!driver)
      throw new CliError(
        '`--driver` marks the human steering this seat — pass a name (`--driver <you>`) or identify yourself with `--as <you>`',
        2,
      );
  }

  // Which harness to wire (ADR 038/085 registry — the same adapters `init` drives). Default to Claude
  // Code for back-compat; a bad id fails fast with the valid set rather than silently doing nothing.
  const harnessId = flagStr(parsed.flags, 'harness') ?? 'claude-code';
  const harness = HARNESSES.find((h) => h.id === harnessId);
  if (!harness) {
    throw new CliError(
      `unknown harness "${harnessId}" — choose one of: ${HARNESSES.map((h) => h.id).join(', ')}`,
      2,
    );
  }

  // Adding a member is an admin act — needs an active identity (binding/env/--as), like `team add`.
  const { team, http, config } = resolve(parsed.flags);

  // The warn-only infra-touch gate (ADR 227 inc 2). This verb re-provisions through
  // harness.configure, which rewrites the MACHINE-SHARED MCP entry every seat on this repo root
  // launches through (ADR 143) and reinstalls hooks — infra consequences the 01KZ9CGYGH outage
  // proved out. One added line for a non-`platform` seat (the daemon writes the audit row), then
  // proceed; every failure mode is silence, same contract as `service`/`reset`.
  const gateWarn = await (deps.infraGate ?? infraTouchWarning)('agent');
  if (gateWarn) process.stdout.write(`${theme.warn(sym.warn)} ${theme.warn(gateWarn)}\n`);

  // ADR 058 §5: write the seat file first for a file-backed team so the file stays the single writer;
  // db-only teams skip this and the daemon originates. addMember revives a soft-removed name (ADR 065).
  const home = loadConfig().rosterHome[team];
  if (home)
    writeSeatFile(home, name, {
      kind: 'agent',
      ...(role ? { role } : {}),
      ...(hue !== undefined ? { hue } : {}),
    });
  // Declare the seat (v0.3: no per-seat token — the agent claims it with the team agent key on launch).
  // Idempotent: if the seat is already declared (e.g. you ran `team add <name>` first, or re-ran this
  // command), reuse it and just (re)build the workspace instead of dead-ending on a conflict — a
  // ready-to-run workspace is the whole point of this command. Guard against reusing a *human* seat.
  let reused = false;
  try {
    await http.addMember(team, {
      name,
      kind: 'agent',
      ...(role ? { role } : {}),
      ...(hue !== undefined ? { hue } : {}),
    });
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== 'conflict') throw err;
    const { members } = await http.roster(team);
    const existing = members.find((m) => m.name === name);
    if (existing && existing.kind !== 'agent') {
      throw new CliError(
        `"${name}" already exists in "${team}" as a ${existing.kind}, not an agent — ` +
          `pick a different name for the agent workspace`,
        err.exitCode,
      );
    }
    reused = true;
  }
  // ADR 344: every provisioned workspace receives a credential constrained to this one seat.
  // Mint after declaration because the server validates the target against the live roster. Never
  // fall back to the ambient legacy Team-wide key: that would silently preserve its blast radius.
  const agentKey = (
    await http.mintBootstrapCredential(team, {
      use: 'claim_seat',
      target: name,
      label: `${harness.id}:${name}`,
    })
  ).agent_key;

  // Mint a standing grant for the seat so the workspace's autojoin occupies immediately on launch
  // instead of opening an admin-approval request every session (ADR 077). Best-effort: if it fails
  // (e.g. the caller isn't admin), the agent still comes online — its first claim just routes through
  // the approval lane. Issuing here is safe: `addMember` above already required an admin identity.
  let grant: string | undefined;
  try {
    const mint = await http.issueGrant(team, { scope: 'seat', target: name, lifetime: 'standing' });
    grant = mint.token;
  } catch {
    grant = undefined;
  }

  const here = Boolean(parsed.flags['here']);
  const ws = provisionWorkspace(name, {
    here,
    team,
    ...(flagStr(parsed.flags, 'path') ? { path: flagStr(parsed.flags, 'path')! } : {}),
  });

  const binding: Binding = {
    version: 2,
    server: config.server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
    ...(model !== undefined ? { model } : {}),
    // Per-worktree, NOT the shared harness entry (ADR 165 inc 2): the entry is keyed by repo root
    // and shared by every sibling worktree, so autojoin/driver baked there applied family-wide —
    // `--driver nick` marked every seat on the machine as driven by nick (ADR 155 corruption).
    autojoin: true,
    ...(driver ? { driver } : {}),
  };
  saveBinding(ws.dir, binding);
  // ADR 261: the permissions floor — plus the profile's lists when --profile names one — lands
  // with the binding, so a NON-INTERACTIVE session in this worktree can work on day one. Until this
  // write, a fresh seat's first Write failed closed with no way to prompt and presented as a
  // broken tool (the 2026-08-13 ryder incident). Best-effort like hook install: a permissions
  // hiccup never fails seat creation. Dir-aware — ws.dir is never cwd().
  try {
    const template = profileName ? loadToolkit(ws.dir, profileName) : undefined;
    installSeatPermissions(ws.dir, template);
  } catch {
    /* an unknown profile name or a broken settings file must not block the seat — init --check
       (ADR 261 increment 2) is the surface that reports it */
  }
  // Also write the secret-free committed launch spec (ADR: committed launch spec) so this worktree
  // self-wires via `musterd wire` on a fresh clone/machine — the key stays out of the committed file.
  saveWorkspaceSpec(ws.dir, {
    version: 2,
    server: config.server,
    team,
    claim: { mode: 'seat', name },
  });

  // Register the MCP server *for the workspace folder*. No secret is baked into any harness config —
  // binding.json stays the single source of truth (ADR 018/115) — and, critically, **we do not name the
  // binding file in the env** (ADR 143).
  //
  // We used to set `MUSTERD_BINDING=<ws.dir>/.musterd/binding.json` here, on the assumption that chdir-ing
  // into `ws.dir` scoped the registration to this worktree: "`claude mcp add -s local` keys off cwd".
  // **That assumption is false.** Claude Code keys its local scope by **repo root**, and every seat
  // worktree (`agents-miley`, `agents-dolly`, …) is a git worktree of the *same* repo — so all of them
  // share one entry, and `MUSTERD_BINDING` was a single global slot that each `musterd agent` overwrote.
  // Provisioning one seat therefore re-pointed *every live session on the machine* at that seat: on
  // 2026-07-13 they all booted as `dolly` and superseded each other off their own seats, mid-task.
  //
  // The env var was never needed here anyway: the adapter anchors on the `.musterd/binding.json` it finds
  // by walking up from its **cwd**, which the harness sets to the session's workspace — a signal that is
  // genuinely per-worktree, unlike the shared config. Omitting it makes the shared entry identical for
  // every seat, and therefore harmless. (The adapter also refuses a cross-workspace `MUSTERD_BINDING`
  // outright now — see `mcp/binding.ts` — so this can't come back through another door.)
  const agentBinding = {
    server: config.server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name } as const,
    ...(grant !== undefined ? { grant } : {}),
  };
  // Seat-agnostic by construction (ADR 143, completed by ADR 165 + increment 2): this entry is keyed
  // by repo root and therefore shared by every seat worktree, so it carries NOTHING — autojoin and
  // driver, the last two baked names, now live in binding.json like everything else. `buildMcpEnv`
  // is where the rule is written down and where the sharedEntry regression binds.
  const entry = buildEntry(agentBinding);
  let mcpError: string | null = null;
  const prevCwd = process.cwd();
  try {
    process.chdir(ws.dir);
    await harness.configure(entry, agentBinding);
  } catch (err) {
    mcpError = (err as Error).message;
  } finally {
    process.chdir(prevCwd);
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        dir: ws.dir,
        kind: ws.kind,
        branch: ws.branch ?? null,
        harness: harness.id,
        mcpRegistered: mcpError === null,
        granted: grant !== undefined,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${reused ? 'reused' : 'added'} ${theme.memberName(name, 'agent')} ${theme.meta(`(agent${role ? `, ${role}` : ''})`)} ${reused ? 'on' : 'to'} ${team}\n`,
  );
  const where =
    ws.kind === 'worktree'
      ? `git worktree on branch ${theme.accent(ws.branch ?? '')}`
      : ws.kind === 'folder'
        ? 'folder'
        : 'this folder';
  process.stdout.write(`${theme.ok(sym.ok)} workspace ${ws.dir} ${theme.meta(`(${where})`)}\n`);

  if (mcpError === null) {
    process.stdout.write(
      success(`wired the musterd MCP server there for ${harness.label} (autojoin)`, {
        next: `open a ${harness.label} session in ${ws.dir} — it joins as ${name} automatically`,
      }) + '\n',
    );
  } else {
    // Member + workspace + binding are set up; only the harness wiring failed (e.g. the harness CLI
    // isn't installed). Point at `musterd init` in the folder, which re-runs the same harness adapter.
    process.stdout.write(
      `${theme.warn(sym.warn)} couldn't auto-register the musterd MCP server for ${harness.label} (${mcpError}).\n` +
        theme.meta(
          `  finish the wiring by running \`musterd init\` in ${ws.dir} and choosing ${harness.label} — ` +
            `the binding.json is already written, so it only needs the harness config.`,
        ) +
        '\n',
    );
  }
  return 0;
}
