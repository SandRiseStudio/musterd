import { LaneStateSchema, type Lane, type LaneWarning } from '@musterd/protocol';
import { resolveProject } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd lane <open|claim|release|handoff|update|resolve>` + `musterd lanes` — the CLI half of the lane
 * dual-surface (ADR 083, parity with the `lane_*` MCP tools). Every mutation prints the lane and any
 * contention warnings inline (warn-only; the verb never fails on contention).
 */

const USAGE =
  'usage:\n' +
  '  musterd lane open "<title>" [--surface <glob>[,<glob>…]] [--depends <id>[,<id>…]] [--goal <id>] [--project p] [--role r] [--branch b] [--detail d] [--claim]\n' +
  '  musterd lane claim <id>\n' +
  '  musterd lane release <id>\n' +
  '  musterd lane handoff <id> --to <seat> [--branch <ref>]\n' +
  '  musterd lane update <id> [--state open|claimed|active|blocked|awaiting_acceptance|done|abandoned] [--surface …] [--depends …] [--branch b] [--detail d] [--project p]\n' +
  '  musterd lane submit <id> [--pr <n>] [--sha <sha>] [--authorized-by <human>]\n' +
  '  musterd lane ready <id> […]  (deprecated alias for submit)\n' +
  '  musterd lane resolve <id> [--pr <n>] [--sha <sha>] [--authorized-by <human>]\n' +
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
      // Derived here, not in the store: the daemon's cwd is the daemon's, so only the caller knows
      // which repo this lane belongs to (--project > MUSTERD_PROJECT > repo identity > 'default').
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
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

  if (sub === 'claim' || sub === 'resolve' || sub === 'ready' || sub === 'submit') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    // resolve/submit may attest the landed merge (ADR 109): {pr, sha, authorized_by}. On resolve it
    // rides the terminal move into `git.pr_merged`; on submit (ADR 192) it is the worker's stage-one
    // claim, persisted on the lane so an acceptor's later accept carries it. `ready` is a deprecated alias.
    const prRaw = flagStr(parsed.flags, 'pr');
    const pr = prRaw !== undefined ? Number(prRaw) : undefined;
    if (pr !== undefined && !Number.isInteger(pr)) throw new CliError(USAGE, 2);
    const merged = {
      ...(pr !== undefined ? { pr } : {}),
      ...(flagStr(parsed.flags, 'sha') !== undefined ? { sha: flagStr(parsed.flags, 'sha')! } : {}),
      ...(flagStr(parsed.flags, 'authorized-by') !== undefined
        ? { authorized_by: flagStr(parsed.flags, 'authorized-by')! }
        : {}),
    };
    const submit = sub === 'ready' || sub === 'submit';
    const res = await http.updateLane(
      team,
      id,
      sub === 'claim'
        ? { owner_seat: identity.name }
        : {
            state: submit ? 'awaiting_acceptance' : 'done',
            ...(Object.keys(merged).length ? { merged } : {}),
          },
    );
    const label = sub === 'claim' ? 'claimed' : submit ? 'submitted for acceptance' : 'done';
    process.stdout.write(`${theme.ok('✓')} lane ${label}\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    if (submit) {
      // ADR 192: report the acceptor routing — who was asked, or that self-close is sanctioned.
      if (res.review?.reviewer) {
        // ADR 235: the advice follows the backstop. "Self-close on silence" was right while an
        // unaccepted lane hung forever; with a sweep armed it is what turns a recoverable wait into
        // a permanent unverified close — measured, the acceptor came back 20 of 20 times, an
        // average 106.8 minutes after the owner had already shut the lane.
        const backstop = res.review.backstop;
        process.stdout.write(
          `acceptance asked of ${theme.memberName(res.review.reviewer, 'agent')} ` +
            theme.meta(
              backstop?.armed
                ? `(${res.review.route}) — you are done; leave it with them. Do NOT self-close on ` +
                    `silence: the daemon sweeps an unanswered lane after ` +
                    `${Math.round(backstop.grace_ms / 3_600_000)}h. \`musterd lane resolve\` still ` +
                    `works if you need it shut now, and records unconfirmed. ` +
                    `Acceptor judges intent/principles/usable/feel — not a code review.`
                : `(${res.review.route}) — wait ≤5m; accept closes the lane, reject resumes it; ` +
                    `on silence, \`musterd lane resolve\` yourself (recorded unconfirmed). ` +
                    `Acceptor judges intent/principles/usable/feel — not a code review.`,
            ) +
            '\n',
        );
      } else {
        process.stdout.write(
          theme.meta(
            'no eligible acceptor is live — self-close sanctioned: ' +
              '`musterd lane resolve` when ready (recorded unconfirmed)',
          ) + '\n',
        );
      }
    }
    if (sub === 'resolve') {
      // ADR 169 advisory nudge: closing your own lane records an unverified close.
      if (res.lane.owner_seat === identity.name) {
        process.stdout.write(
          theme.meta(
            'unconfirmed close recorded — prefer `musterd lane submit` when an acceptor is live (ADR 192)',
          ) + '\n',
        );
      }
      renderBranchCleanup(res.lane.branch);
    }
    return 0;
  }

  if (sub === 'release') {
    // The complement of `claim`: hand the lane back to the board rather than to a seat. `open` means
    // unowned, so the state move IS the release — the store clears the owner and the claim stamp.
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const res = await http.updateLane(team, id, { state: 'open' });
    process.stdout.write(
      `${theme.ok('✓')} lane released — open for anyone\n${renderLane(res.lane)}\n`,
    );
    renderWarnings(res.warnings);
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
      ...(flagStr(parsed.flags, 'project') !== undefined
        ? { project: flagStr(parsed.flags, 'project')! }
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
