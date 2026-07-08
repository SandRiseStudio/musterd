import { LaneStateSchema, type Lane, type LaneWarning } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd lane <open|claim|handoff|update|resolve>` + `musterd lanes` — the CLI half of the lane
 * dual-surface (ADR 083, parity with the `lane_*` MCP tools). Every mutation prints the lane and any
 * contention warnings inline (warn-only; the verb never fails on contention).
 */

const USAGE =
  'usage:\n' +
  '  musterd lane open "<title>" [--surface <glob>[,<glob>…]] [--depends <id>[,<id>…]] [--goal <id>] [--project p] [--role r] [--branch b] [--detail d] [--claim]\n' +
  '  musterd lane claim <id>\n' +
  '  musterd lane handoff <id> --to <seat> [--branch <ref>]\n' +
  '  musterd lane update <id> [--state open|claimed|active|blocked|done|abandoned] [--surface …] [--depends …] [--branch b] [--detail d]\n' +
  '  musterd lane resolve <id>\n' +
  '  musterd lanes [--project p] [--mine] [--open] [--json]';

/** Split a comma-separated repeatable flag; undefined when the flag is absent. */
function list(flags: Record<string, string | boolean>, name: string): string[] | undefined {
  const raw = flagStr(flags, name);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderLane(l: Lane): string {
  const owner = l.owner_seat ? theme.memberName(l.owner_seat, 'agent') : theme.meta('unowned');
  const state =
    l.state === 'done' ? theme.ok(l.state) : l.state === 'blocked' ? theme.warn(l.state) : l.state;
  const surface = l.surface_globs.length ? theme.meta(` [${l.surface_globs.join(', ')}]`) : '';
  const deps = l.depends_on.length ? theme.meta(` deps:${l.depends_on.length}`) : '';
  const branch = l.branch ? theme.meta(` ⎇ ${l.branch}`) : '';
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  return `${theme.meta(l.id)} ${state} "${l.title}" — ${owner} · ${l.project}${goal}${surface}${deps}${branch}`;
}

function renderWarnings(warnings: LaneWarning[]): void {
  for (const w of warnings) {
    // For stale_plan the `with` is the moved Goal; for the others it's the other lane.
    const ref = w.kind === 'stale_plan' ? `goal ${w.with}` : `lane ${w.with}`;
    process.stdout.write(`${theme.warn('⚠')} ${w.kind}: ${w.detail} ${theme.meta(`(${ref})`)}\n`);
  }
  if (warnings.length > 0) {
    process.stdout.write(theme.meta('advisory only — coordinate or adjust; never blocked') + '\n');
  }
}

/**
 * On lane closure, remind the agent to clear the lane's *local* branch (ADR 106). GitHub auto-deletes
 * the remote branch on merge; the local one lingers in the worktree, and the naive cleanup fails —
 * you can't `git checkout main` (a sibling worktree owns it) and `git branch -d` refuses a
 * squash-merged branch. The worktree-safe move detaches to fresh `origin/main` (the next lane's start
 * state) and force-deletes. No-op when the lane carries no branch.
 */
function renderBranchCleanup(branch: string | null): void {
  if (!branch) return;
  process.stdout.write(
    theme.meta('landed? clear the local branch (the remote auto-deleted on merge):') + '\n',
  );
  process.stdout.write(
    theme.meta(
      `  git fetch origin main --prune && git switch --detach origin/main && git branch -D ${branch}`,
    ) + '\n',
  );
}

export async function laneCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const { team, identity, http } = resolve(parsed.flags);

  if (sub === 'open') {
    const title = parsed.positionals[1];
    if (!title) throw new CliError(USAGE, 2);
    const res = await http.openLane(team, {
      title,
      ...(flagStr(parsed.flags, 'detail') !== undefined
        ? { detail: flagStr(parsed.flags, 'detail')! }
        : {}),
      ...(flagStr(parsed.flags, 'project') !== undefined
        ? { project: flagStr(parsed.flags, 'project')! }
        : {}),
      ...(flagStr(parsed.flags, 'role') !== undefined
        ? { role: flagStr(parsed.flags, 'role')! }
        : {}),
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
      ...(flagStr(parsed.flags, 'goal') !== undefined
        ? { goal_id: flagStr(parsed.flags, 'goal')! }
        : {}),
      ...(list(parsed.flags, 'surface') !== undefined
        ? { surface_globs: list(parsed.flags, 'surface')! }
        : {}),
      ...(list(parsed.flags, 'depends') !== undefined
        ? { depends_on: list(parsed.flags, 'depends')! }
        : {}),
      ...(parsed.flags['claim'] === true ? { claim: true } : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane opened\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'claim' || sub === 'resolve') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const res = await http.updateLane(
      team,
      id,
      sub === 'claim' ? { owner_seat: identity.name } : { state: 'done' },
    );
    process.stdout.write(
      `${theme.ok('✓')} lane ${sub === 'claim' ? 'claimed' : 'done'}\n${renderLane(res.lane)}\n`,
    );
    renderWarnings(res.warnings);
    if (sub === 'resolve') renderBranchCleanup(res.lane.branch);
    return 0;
  }

  if (sub === 'handoff') {
    const id = parsed.positionals[1];
    const to = flagStr(parsed.flags, 'to');
    if (!id || !to) throw new CliError(USAGE, 2);
    const res = await http.updateLane(team, id, {
      owner_seat: to,
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane handed to ${to}\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'update') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const stateRaw = flagStr(parsed.flags, 'state');
    const state = stateRaw !== undefined ? LaneStateSchema.parse(stateRaw) : undefined;
    const res = await http.updateLane(team, id, {
      ...(state !== undefined ? { state } : {}),
      ...(flagStr(parsed.flags, 'detail') !== undefined
        ? { detail: flagStr(parsed.flags, 'detail')! }
        : {}),
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
      ...(list(parsed.flags, 'surface') !== undefined
        ? { surface_globs: list(parsed.flags, 'surface')! }
        : {}),
      ...(list(parsed.flags, 'depends') !== undefined
        ? { depends_on: list(parsed.flags, 'depends')! }
        : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane updated\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    return 0;
  }

  throw new CliError(USAGE, 2);
}

/** `musterd lanes` — the board: who owns what, in what state, with live contention warnings. */
export async function lanesCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);
  const board = await http.laneBoard(team, {
    ...(flagStr(parsed.flags, 'project') !== undefined
      ? { project: flagStr(parsed.flags, 'project')! }
      : {}),
    ...(parsed.flags['mine'] === true ? { mine: true } : {}),
    ...(parsed.flags['open'] === true ? { open: true } : {}),
  });
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(board) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent('lanes')} — ${team} (${board.lanes.length} lane${board.lanes.length === 1 ? '' : 's'}, viewing as ${identity.name})\n`,
  );
  if (board.lanes.length === 0) {
    process.stdout.write(
      theme.meta('no lanes — `musterd lane open "<title>" --claim` to declare your work') + '\n',
    );
    return 0;
  }
  for (const l of board.lanes) process.stdout.write(renderLane(l) + '\n');
  renderWarnings(board.warnings);
  return 0;
}
