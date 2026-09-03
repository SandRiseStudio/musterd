import type { Lane } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';
import { renderSubmitReport } from './lane.js';

/**
 * `musterd done [<lane-id>] [--pr <n>] [--sha <sha>] [--authorized-by <human>]` — close the unit of
 * work (ADR 049 as amended by 084) and chain into orientation. Auto-targets your single live lane
 * when no id is given; the toil-killer half of the next/done pair.
 *
 * It says what it records (surface survey 2026-09-03, collision 2 — closing a lane had four verbs
 * and this, the friendliest, was the only one silent about the ledger):
 * - with a merge attestation it IS a submit: the lane goes to awaiting_acceptance and the routing
 *   report prints, exactly as `musterd lane submit` (ADR 192);
 * - without one it marks the lane done and says so — an unconfirmed self-close (ADR 169), unless
 *   the lane is acceptance-exempt (ADR 234), in which case nothing is owed and it says that instead;
 * - a lane already awaiting acceptance is refused: a bare `done` there would override an acceptance
 *   somebody was routed. `musterd lane resolve` remains the explicit way to shut it regardless.
 */

const LIVE: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked']);

function laneLine(l: Lane): string {
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  return `  ${theme.meta(l.id)} ${l.state} "${l.title}"${goal}`;
}

export async function doneCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);

  const board = await http.laneBoard(team, {});
  let id = parsed.positionals[0];
  if (!id) {
    // Auto-target: the caller's single live lane. Zero → nothing to close; many → ask which.
    const live = board.lanes.filter((l) => l.owner_seat === identity.name && LIVE.has(l.state));
    if (live.length === 0) {
      throw new CliError(
        `no live lane to close for ${identity.name} — open one with \`musterd lane open "<title>" --claim\``,
        1,
      );
    }
    if (live.length > 1) {
      const lines = live.map(laneLine).join('\n');
      throw new CliError(
        `you own ${live.length} live lanes — name one: \`musterd done <lane-id>\`\n${lines}`,
        2,
      );
    }
    id = live[0]!.id;
  }

  const target = board.lanes.find((l) => l.id === id);
  if (target?.state === 'awaiting_acceptance') {
    throw new CliError(
      `lane ${id} is already awaiting acceptance — leave it with the acceptor. ` +
        `\`musterd lane resolve ${id}\` if you genuinely need it shut now (recorded unconfirmed).`,
      1,
    );
  }

  // A merge attestation (ADR 109) makes this a submit, not a self-close.
  const prRaw = flagStr(parsed.flags, 'pr');
  const pr = prRaw !== undefined ? Number(prRaw) : undefined;
  if (pr !== undefined && !Number.isInteger(pr)) {
    throw new CliError(
      'usage: musterd done [<lane-id>] [--pr <n>] [--sha <sha>] [--authorized-by <human>]',
      2,
    );
  }
  const sha = flagStr(parsed.flags, 'sha');
  const authorizedBy = flagStr(parsed.flags, 'authorized-by');
  const merged = {
    ...(pr !== undefined ? { pr } : {}),
    ...(sha !== undefined ? { sha } : {}),
    ...(authorizedBy !== undefined ? { authorized_by: authorizedBy } : {}),
  };
  const submitting = Object.keys(merged).length > 0;

  const res = await http.updateLane(
    team,
    id,
    submitting ? { state: 'awaiting_acceptance', merged } : { state: 'done' },
  );
  process.stdout.write(
    `${theme.ok('✓')} ${submitting ? 'submitted for acceptance' : 'done'}\n${laneLine(res.lane)}\n`,
  );
  if (submitting) {
    renderSubmitReport(res);
  } else if (res.review?.acceptance_exempt) {
    process.stdout.write(
      theme.meta('acceptance-exempt (declared low stakes, ADR 234) — closed, nothing owed') + '\n',
    );
  } else {
    process.stdout.write(
      theme.meta(
        'unconfirmed close recorded (ADR 169) — after a merge, prefer ' +
          '`musterd done --pr <n> --sha <sha>`, which routes through submit and asks an acceptor (ADR 192)',
      ) + '\n',
    );
  }

  // Chain into orientation: what's next now that this landed (the pair's whole point).
  const brief = await http.next(team);
  if (brief.up_next.length > 0) {
    process.stdout.write(`\n${theme.accent('up next')} — \`musterd next\` for the full brief:\n`);
    for (const l of brief.up_next.slice(0, 3)) process.stdout.write(laneLine(l) + '\n');
  }
  return 0;
}
