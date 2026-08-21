import type { McpServer } from '@modelcontextprotocol/server';
import {
  closeReasonCopy,
  incidentBannerLines,
  LaneStateSchema,
  shortDuration,
  type Lane,
  type LaneWarning,
  type NextBrief,
} from '@musterd/protocol';
import { resolveProject } from '@musterd/protocol/project';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { SHA_FORMAT, verifyMerge } from '../mergeVerify.js';
import { errorResult, textResult } from './format.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — declare the unit of work you own so musterd can warn
 * (never block) on unmet dependencies and surface overlap, and so a handoff carries the branch
 * instead of a prose description. Warnings come back inline; the affected owner gets one directed
 * wake; the board is the pull view.
 */

function fmtLane(l: Lane): string {
  const owner = l.owner_seat ?? 'unowned';
  const surface = l.surface_globs.length ? ` surface=[${l.surface_globs.join(', ')}]` : '';
  const deps = l.depends_on.length ? ` deps=[${l.depends_on.join(', ')}]` : '';
  const branch = l.branch ? ` branch=${l.branch}` : '';
  const goal = l.goal_id ? ` goal=${l.goal_id}` : '';
  return `${l.id} [${l.state}] "${l.title}" — owner=${owner} project=${l.project}${goal}${surface}${deps}${branch}`;
}

function fmtWarnings(warnings: LaneWarning[]): string {
  if (warnings.length === 0) return '';
  return (
    '\n⚠ ' +
    warnings.map((w) => `${w.kind}: ${w.detail} (lane ${w.with})`).join('\n⚠ ') +
    '\n(advisory — coordinate with the owner or adjust your lane; never blocked)'
  );
}

function fmtResult(prefix: string, lane: Lane, warnings: LaneWarning[]): string {
  return `${prefix}\n${fmtLane(lane)}${fmtWarnings(warnings)}`;
}

/**
 * The lane-mutation result, structured-first (ADR 144 inc 3): the prose stays for a reading agent;
 * the `structuredContent` carries the lane and warnings for a programmatic caller (the lane id is
 * what every follow-up call — update, handoff, resolve — needs), with any next-action `hint` as a
 * field rather than only buried in the text.
 */
function laneResult(prefix: string, lane: Lane, warnings: LaneWarning[], hint?: string) {
  return {
    content: [{ type: 'text' as const, text: fmtResult(prefix, lane, warnings) + (hint ?? '') }],
    structuredContent: {
      lane: { ...lane },
      warnings: warnings.map((w) => ({ ...w })),
      ...(hint ? { hint: hint.trim() } : {}),
    },
  };
}

/**
 * On lane closure, remind the agent to clear the lane's local branch (ADR 106). GitHub auto-deletes
 * the *remote* branch on merge, but the local one lingers in the worktree — and the naive cleanup
 * fails here: you can't `git checkout main` (a sibling worktree owns it) and `git branch -d` refuses
 * a squash-merged branch (it isn't an ancestor of main). The worktree-safe move detaches to fresh
 * `origin/main` (also the start state for the next lane) and force-deletes. Empty when no branch.
 */
function branchCleanupHint(lane: Lane): string {
  if (!lane.branch) return '';
  return (
    `\n\nlanded? clear the local branch (the remote auto-deleted on merge):\n` +
    `  git fetch origin main --prune && git switch --detach origin/main && git branch -D ${lane.branch}`
  );
}

export function registerLanes(
  server: McpServer,
  client: MusterdClient,
  verify: typeof verifyMerge = verifyMerge,
): void {
  server.registerTool(
    'lane_open',
    {
      description:
        'Declares a unit of work as a lane: title, the paths it touches, what it builds on. ' +
        'claim:true takes ownership when the work is yours. Returns the lane + ' +
        'advisory contention warnings (unmet dependency, surface overlap) — never blocking.',
      inputSchema: {
        title: z.string().describe('the work-item, short'),
        detail: z.string().optional().describe('acceptance criteria / notes'),
        project: z
          .string()
          .optional()
          .describe('surface-space scope; defaults to this workspace’s repo'),
        surface_globs: z
          .array(z.string())
          .optional()
          .describe('declared paths, e.g. ["packages/server/src/store/**"]'),
        depends_on: z.array(z.string()).optional().describe('lane ids this lane builds on'),
        branch: z.string().optional().describe('git branch carrying the work'),
        goal_id: z
          .string()
          .optional()
          .describe('link this lane to a Goal (team_next groups by it)'),
        role: z.string().optional().describe('assignment hint (advisory)'),
        stakes: z
          .enum(['low', 'normal', 'high'])
          .optional()
          .describe(
            'how much this is worth someone’s eyes (default normal). Declared, not inferred ' +
              'from the files; a low lane may be exempted from acceptance (ADR 234)',
          ),
        claim: z.boolean().optional().describe('own it yourself now (recommended at task start)'),
      },
    },
    async (args) => {
      try {
        // Derived here, not in the store: the daemon's cwd is the daemon's, so only this adapter —
        // running in the seat's own workspace — knows which repo the lane belongs to.
        const { lane, warnings } = await client.openLane({
          ...args,
          project: resolveProject({ explicit: args.project }),
        });
        return laneResult('lane opened', lane, warnings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'lane_claim',
    {
      description:
        'Take ownership of an open lane. Refuses a lane a live teammate already owns — ask them to ' +
        'hand it over or release it. Returns the lane + contention warnings.',
      inputSchema: {
        id: z.string().describe('lane id'),
        goal_id: z.string().optional().describe('link a goal as you take it (one call)'),
      },
    },
    async (args) => {
      try {
        if (!client.member) return textResult('claim a seat first (team_join)');
        const { lane, warnings } = await client.updateLane(args.id, {
          owner_seat: client.member,
          ...(args.goal_id ? { goal_id: args.goal_id } : {}),
        });
        return laneResult('lane claimed', lane, warnings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'lane_release',
    {
      description:
        'Let go of a lane you own without finishing it — it returns to the board as open for ' +
        'anyone. Use when you park work rather than complete it; a claimed lane sitting idle ' +
        'reserves work nobody is doing.',
      inputSchema: { id: z.string().describe('lane id') },
    },
    async (args) => {
      try {
        // `open` means unowned, so the state move is the whole release — the store clears the owner.
        const { lane, warnings } = await client.updateLane(args.id, { state: 'open' });
        return laneResult('lane released — open for anyone', lane, warnings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'lane_board',
    {
      description:
        'The lane board: who owns what, in what state, with live contention warnings. Pull at ' +
        'task start and before picking up new work.',
      inputSchema: {
        project: z.string().optional().describe('filter to one project'),
        mine: z.boolean().optional().describe('only lanes I own'),
        open: z.boolean().optional().describe('only unowned/claimable lanes'),
      },
    },
    async (args) => {
      try {
        const { lanes, warnings } = await client.laneBoard(args);
        if (lanes.length === 0) return textResult('no lanes — lane_open to declare your work');
        const body = lanes.map(fmtLane).join('\n');
        return textResult(`${body}${fmtWarnings(warnings)}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'lane_handoff',
    {
      description:
        'Hand a lane to another seat with its branch, so work arrives as an artifact. Put the ' +
        'why in `note` — it rides the same act, so no second send. Wake-eligible if they are ' +
        'offline + host-enrolled.',
      inputSchema: {
        id: z.string().describe('lane id'),
        to: z.string().describe('recipient seat'),
        branch: z.string().optional().describe('branch carrying the work'),
        note: z.string().optional().describe('why you are handing it over'),
      },
    },
    async (args) => {
      try {
        const { lane, warnings } = await client.updateLane(args.id, {
          owner_seat: args.to,
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.note ? { handoff_note: args.note } : {}),
        });
        return laneResult(`lane handed to ${args.to}`, lane, warnings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'lane_update',
    {
      description:
        'Update a lane: state (active/blocked/done/…), title, surface_globs, depends_on, branch, ' +
        'detail, project, goal_id. Going active re-runs contention checks.',
      inputSchema: {
        id: z.string().describe('lane id'),
        // Derived from the protocol schema (ADR 169 consolidation) — this enum was hand-duplicated
        // and silently missed new states.
        state: z.enum(LaneStateSchema.options).optional().describe('new state'),
        title: z.string().min(1).optional().describe('correct a mis-stated title'),
        detail: z.string().optional(),
        surface_globs: z.array(z.string()).optional(),
        stakes: z
          .enum(['low', 'normal', 'high'])
          .optional()
          .describe('re-declare acceptance stakes (ADR 234): low | normal | high'),
        depends_on: z.array(z.string()).optional(),
        branch: z.string().optional(),
        project: z.string().optional().describe('re-scope the surface-space'),
        // Protocol UpdateLaneSchema already has this; the MCP schema omitted it, so the ADR 256
        // no_goal warning named a call (`lane_update {goal_id}`) that bounced as unknown.
        goal_id: z
          .string()
          .nullable()
          .optional()
          .describe('link (or clear, with null) this lane to a Goal'),
      },
    },
    async (args) => {
      try {
        const { id, ...patch } = args;
        const { lane, warnings } = await client.updateLane(id, patch);
        return laneResult('lane updated', lane, warnings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const laneSubmitHandler = async (args: {
    id: string;
    pr?: number | undefined;
    sha?: string | undefined;
    authorized_by?: string | undefined;
    branch?: string | undefined;
  }) => {
    try {
      // Merge-verified submit: awaiting_acceptance MEANS landed. The repo is the source of
      // truth for "merged" — the attested SHA is checked against origin/main right here, at
      // the author's own act, so the "your PR never landed" nudge reaches the one seat that
      // owns the missing merge at the moment it can act (no poller: ADR 294 dec 2 / ADR 297).
      // Refusals need POSITIVE evidence; abstentions (cross-repo lane, offline) proceed with
      // the tier recorded on the attestation (ADR 145: degrade, never wedge).
      if (args.sha !== undefined && !SHA_FORMAT.test(args.sha)) {
        return textResult(
          `"${args.sha}" is not a git SHA — pass the squash-merge SHA from origin/main ` +
            `(git log --oneline -1 after the merge lands).`,
        );
      }
      if (args.pr !== undefined && args.sha === undefined) {
        return textResult(
          `a PR number without a landed SHA is an open PR — nothing has landed, so there is ` +
            `nothing to accept yet. Arm auto-merge (gh pr merge --squash --auto ${args.pr}), ` +
            `wait for the merge, then resubmit with the squash SHA.`,
        );
      }
      const verification = await verify({ sha: args.sha, cwd: process.cwd() });
      if (verification === 'not_ancestor') {
        return textResult(
          `SHA ${args.sha} is not on origin/main — nothing landed. If the PR is still open, ` +
            `arm auto-merge and resubmit with the real squash SHA once it lands; if this ` +
            `landed somewhere else on purpose, that flow needs a design, not a workaround.`,
        );
      }
      const merged = {
        ...(args.pr !== undefined ? { pr: args.pr } : {}),
        ...(args.sha !== undefined ? { sha: args.sha } : {}),
        ...(args.authorized_by !== undefined ? { authorized_by: args.authorized_by } : {}),
        verification,
      };
      const { lane, warnings, review } = await client.updateLane(args.id, {
        state: 'awaiting_acceptance',
        merged,
        // ADR 083's argument for `branch` is that work should reach the next person as an ARTIFACT
        // rather than a description — and submit, which hands the lane to an acceptor, is the moment
        // that matters most. It was the one lane edge that could not set it: `branch` is valid on
        // lane_open, lane_handoff and lane_update, so seats reached for it here too and were bounced
        // (measured 2026-08-05: 99 ok / 22 invalid_input, the worst ratio of any lane tool, against
        // lane_open's 275/7). They were right about what the call should do. 184 of 362
        // terminal-or-awaiting lanes carry branch=null, so acceptors routinely get an empty pointer
        // and dig the branch out of a PR link or a status_update.
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
      });
      // ADR 235. The old advice — "wait ≤5m; on silence, lane_resolve yourself" — was correct while
      // an unaccepted lane hung forever: self-close was the only escape. With a backstop armed it
      // became the thing destroying verdicts. Measured over 20 such closes: the owner closed after
      // 8.5 minutes and the named acceptor came back online in 20 of 20 cases, 55% inside an hour,
      // 100% inside the 24h grace, an average 106.8 minutes after the lane was already shut.
      //
      // So the recommendation follows the backstop, and self-close stays POSSIBLE either way — this
      // changes which action is advised, never which is allowed (ADR 145: degrade, never wedge).
      // A repeat submit (recording a merge SHA after the PR landed — the normal flow) re-routes
      // nothing, and the server now reports the STANDING acceptance state instead of staying
      // silent. Before it did, this client read the silence as "no eligible acceptor is live" and
      // sanctioned self-close against lanes whose acceptor had a pending ask — inviting exactly the
      // premature unverified close ADR 235 measured 20-for-20 and shipped to stop.
      const hint = review?.standing
        ? review.reviewer
          ? `\n\nalready awaiting acceptance from ${review.reviewer}` +
            `${review.route ? ` (${review.route})` : ''} — attestation recorded, nothing re-routed. ` +
            `Leave it with them.`
          : review.acceptance_exempt
            ? `\n\nalready awaiting close — this submit was acceptance-exempt (declared low stakes, ` +
              `ADR 234): lane_resolve when ready.`
            : // Nothing was ever routed (the original submit found no candidate). The sanction was
              // and remains honest here — nobody was asked, so no verdict is coming.
              `\n\nno acceptor was ever routed — self-close sanctioned: ` +
              `lane_resolve when ready (recorded unconfirmed).`
        : !review
          ? // No routing decision AND no standing report (a pre-fix daemon, or a patch that never
            // touched acceptance). Absence of a decision is not absence of an acceptor (ADR 173):
            // abstain rather than assert, and never sanction self-close on silence.
            ''
          : review.acceptance_exempt
            ? // ADR 234 increment 2: no ask by DESIGN, on the lane's own declared stakes — not the
              // "nobody was eligible" degradation, and the wording must not conflate them.
              `\n\nacceptance-exempt (declared low stakes, ADR 234) — no ask was routed and none ` +
              `is owed: lane_resolve when ready.`
            : !review.reviewer
              ? // A fresh submit that found nobody. Nobody was asked, so no verdict is coming and
                // waiting out a grace would be pure delay. This branch keeps its sanction whether or
                // not a sweep is armed.
                `\n\nno eligible acceptor is live — self-close sanctioned: ` +
                `lane_resolve when ready (recorded unconfirmed).`
              : review.backstop?.armed
                ? `\n\nacceptance asked of ${review.reviewer} (${review.route}) — you are done; leave it ` +
                  `with them. Do NOT self-close on silence: acceptors who were offline at submit came ` +
                  `back 20 of 20 times, and the daemon sweeps an unanswered lane after ` +
                  `${Math.round(review.backstop.grace_ms / 3_600_000)}h anyway. lane_resolve still works ` +
                  `if you genuinely need it shut now, and records unconfirmed. Acceptor judges ` +
                  `intent/principles/usable/feel — not the diff.`
                : `\n\nacceptance asked of ${review.reviewer} (${review.route}) — wait ≤5m; ` +
                  `accept closes the lane, reject resumes it; on silence, lane_resolve yourself ` +
                  `(recorded unconfirmed). Acceptor judges intent/principles/usable/feel — not the diff.`;
      return laneResult('lane submitted for acceptance', lane, warnings, hint);
    } catch (err) {
      return errorResult(err);
    }
  };

  server.registerTool(
    'lane_submit',
    {
      description:
        // The unlanded-refusal behavior (ADR 300) is deliberately NOT described here: the standing
        // tools/list surface is budget-gated (context:check), and the refusal message itself
        // teaches at the only moment it matters — when an unlanded submit is attempted.
        'Your work is merged — move the lane to awaiting_acceptance (ADR 192) and attest it ' +
        '(pr/sha/branch/authorized_by). OUTCOME ACCEPTANCE, not a code review: an acceptor judges ' +
        'intent/principles/usable/feel of the landed artifact. Accept closes the lane, reject ' +
        'returns it to active. The response says whether to wait or self-close — follow it, not a ' +
        'fixed timer (ADR 235). Auto-merge first, then submit.',
      inputSchema: {
        id: z.string().describe('lane id'),
        pr: z.number().int().optional().describe('landed PR number; omit for a local merge'),
        sha: z.string().optional().describe('squash-merge SHA on main'),
        authorized_by: z
          .string()
          .optional()
          .describe('the human whose authority the merge ran under'),
        branch: z.string().optional().describe('branch carrying the work'),
      },
    },
    laneSubmitHandler,
  );

  // Deprecated alias for lane_submit (ADR 192) — keep registered so older sessions/harness memory work.
  server.registerTool(
    'lane_ready',
    {
      description: 'Deprecated alias for lane_submit (ADR 192) — prefer lane_submit.',
      inputSchema: {
        id: z.string().describe('lane id'),
        pr: z.number().int().optional().describe('landed PR number; omit for a local merge'),
        sha: z.string().optional().describe('squash-merge SHA on main'),
        authorized_by: z
          .string()
          .optional()
          .describe('the human whose authority the merge ran under'),
        branch: z.string().optional().describe('branch carrying the work'),
      },
    },
    laneSubmitHandler,
  );

  server.registerTool(
    'lane_resolve',
    {
      description:
        'Mark a lane done — clears its warnings and releases its surface. If you own the lane and ' +
        'its branch landed, attest the merge: pass pr, sha, and authorized_by so the audit log ' +
        'joins your seat to the landed SHA and the authorizing human. Landed without a PR? Omit pr ' +
        'and pass sha alone. Closing a lane you do not own (counterpart accept): omit pr/sha/' +
        "authorized_by — the worker's stage-one attestation is frozen (ADR 305); a partial merged " +
        'patch is ignored. Prefer lane_submit (ADR 192): a self-close records unconfirmed unless ' +
        'acceptance-exempt.',
      inputSchema: {
        id: z.string().describe('lane id'),
        // `pr` is the PR *number*. Callers reached for `pr:"local"` to mean "merged without a PR";
        // the description now names the real answer (omit it), and coercion accepts "343"/"#343"
        // but deliberately not a non-numeric word — attesting a PR that never existed would
        // corrupt the seat→PR→SHA audit join (ADR 109) that this field exists to feed.
        pr: z.number().int().optional().describe('landed PR number; omit for a local merge'),
        sha: z.string().optional().describe('squash-merge SHA on main'),
        authorized_by: z
          .string()
          .optional()
          .describe('the human whose authority the merge ran under'),
      },
    },
    async (args) => {
      try {
        const merged = {
          ...(args.pr !== undefined ? { pr: args.pr } : {}),
          ...(args.sha !== undefined ? { sha: args.sha } : {}),
          ...(args.authorized_by !== undefined ? { authorized_by: args.authorized_by } : {}),
        };
        const { lane, warnings, notices, closed } = await client.updateLane(args.id, {
          state: 'done',
          ...(Object.keys(merged).length ? { merged } : {}),
        });
        // ADR 192 advisory nudge: closing your own lane is an unconfirmed close — legal, honest,
        // and worth one line. A counterpart closing someone else's lane accepts it; no nudge.
        //
        // ADR 283/234: but only when an acceptance was actually OWED. This branched on ownership
        // alone, so a lane the daemon had just exempted was told it recorded an "unconfirmed close"
        // and should have preferred `lane_submit` — the opposite of what `lane_submit` told it one
        // call earlier ("none is owed: lane_resolve when ready"), and a surprise about its ledger
        // label of exactly the kind `close_records` is sent at submit to prevent. The recorded
        // reason is read here rather than re-derived from `lane.stakes`: stakes are editable after
        // open, so re-deriving would let an edit rewrite what the submit did.
        //
        // Absence abstains INTO the old nudge, not out of it: an older daemon sends no `closed`,
        // and dropping the ADR 192 line for every seat on a lagging daemon is the worse failure.
        const nudge =
          closed?.reason === 'acceptance_exempt'
            ? '\n\nno acceptance was owed — declared low stakes (ADR 234); the ledger records ' +
              'this close as `acceptance_exempt`, not as a missing review.'
            : client.member && lane.owner_seat === client.member
              ? '\n\nunconfirmed close recorded — prefer lane_submit when an acceptor is live (ADR 192).'
              : '';
        // value-layer design: the daemon's advisory notices (e.g. the ship nudge) reach the closer.
        const noticeText = notices?.length ? '\n\n' + notices.join('\n') : '';
        const hint = noticeText + nudge + branchCleanupHint(lane);
        return laneResult('lane done', lane, warnings, hint || undefined);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_next',
    {
      description:
        'Your orientation brief at session start: what you are carrying, what just shipped, open ' +
        "lanes to pick up, and the latest handoff's why — derived from the team's own lane and " +
        'act state, no human prompt needed.',
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(fmtNext(await client.next()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/** Coarse elapsed time — the reader needs "hours, not minutes", never a precise duration. */
export function fmtNext(b: NextBrief): string {
  const lines: string[] = [`next — as ${b.member}`];
  // Incident banner FIRST, above everything (spec 2026-08-14 §4): most of the measured waste in the
  // motivating episode was seats starting sessions into a shared red they assumed was theirs. Same
  // `?? []` daemon-skew tolerance as owed_reviews below.
  // The words come from the protocol package, not from here (ADR 084). They used to live inline in
  // this function only — which is exactly why `musterd next` showed no banner at all for two whole
  // increments. A shared derivation with a per-surface renderer drifts the moment one copy is edited.
  for (const inc of b.incidents ?? []) lines.push(...incidentBannerLines(inc));
  // FIRST, above your own work, on purpose (ADR 233). This is the one item in the brief that
  // someone else is blocked on, and it is the one that loses when a seat is busy: half the
  // unverified closes had the named reviewer online for ~40 minutes and still never answering.
  // Putting it under `carrying` would reproduce the failure it exists to fix.
  // `?? []` is not defensive noise: `client.next()` casts the response instead of parsing it
  // through NextBriefSchema, so a daemon predating ADR 233 omits the key and this would throw on
  // `.length`. Additive means the OLD daemon can omit it, which makes tolerating that the new
  // client's job.
  const owed = b.owed_reviews ?? [];
  // goals-front-door design: the brief leads with the missions. Same `?? []` skew tolerance as
  // owed_reviews — an older daemon omits the key.
  const goals = b.goals ?? [];
  if (goals.length) {
    lines.push(`\ngoals in flight (${goals.length}):`);
    for (const g of goals) {
      const story = g.story ? ` — "${g.story}"` : '';
      const wave = g.wave !== null ? ` wave=${g.wave}` : '';
      lines.push(`  ${g.id} [${g.status}] "${g.title}"${story}${wave}`);
    }
  }
  if (owed.length) {
    const now = Date.now();
    lines.push(`\n⧗ owed by you — ${owed.length} lane(s) waiting on your verdict:`);
    for (const r of owed) {
      lines.push(
        `  ${r.lane.id} "${r.lane.title}" — ${r.from} has waited ${shortDuration(now - r.ts)}`,
      );
      lines.push(
        `    answer: team_send {act:'accept', to:'${r.from}', reply_to:'${r.ask_id}', body:'…'}`,
      );
    }
  }
  if (b.in_flight.length) {
    lines.push(`\ncarrying (${b.in_flight.length}):`);
    for (const l of b.in_flight) lines.push('  ' + fmtLane(l));
  }
  // value-layer design: ambient review debt — the oldest lanes waiting on ANY seat's acceptance
  // (owed_reviews above is the directed slice). Same `?? []` daemon-skew tolerance as the rest.
  const debt = b.review_debt ?? [];
  if (debt.length) {
    // The total, when the daemon knows more are waiting than it showed. A window that does not say
    // it is a window reads as the whole queue — a seat clears three, looks again, and finds more.
    const total = b.review_debt_total ?? 0;
    const more = total > debt.length ? ` (showing ${debt.length} of ${total})` : '';
    lines.push(`\n⧗ review debt — waiting on any seat's acceptance${more}:`);
    // Owner stays visible even though the daemon filters the reader's own lanes out: a skewed
    // older daemon won't, and whose work it is decides whether accepting counts (ADR 192).
    for (const r of debt)
      lines.push(
        `  ${r.id} "${r.title}"${r.owner ? ` — owner=${r.owner}` : ''} — waiting ${Math.floor(r.waited_ms / 3_600_000)}h` +
          // Not "nobody has answered" — nobody was ASKED. The distinction is the whole point:
          // waiting on a slow reviewer and waiting on no reviewer look identical here otherwise.
          (r.no_candidate ? ' — NO REVIEWER WAS ASKED (no eligible counterpart at submit)' : '') +
          // Merge-verified submit: no SHA on the attestation means nothing landed — the wait
          // is on the author's merge button, and holding for it wastes an acceptor's cycle.
          (r.unlanded
            ? ' — NO MERGE ATTESTATION (nothing landed — waiting on its author, not you)'
            : ''),
      );
  }
  if (b.up_next.length) {
    lines.push('\nup next — open lanes you could pick up:');
    for (const l of b.up_next) {
      lines.push('  ' + fmtLane(l));
      if ((b.goals ?? []).length > 0 && l.goal_id === null)
        lines.push('    (on no goal — link it: lane_update {goal_id})');
    }
  }
  if (b.shipped.length) {
    lines.push('\nrecently shipped:');
    for (const l of b.shipped)
      lines.push(
        `  ✓ "${l.title}"${l.goal_id ? ` goal=${l.goal_id}` : ''}` +
          // ADR 192's copy, the same the web board's chip has carried since ADR 169: `verified` is
          // the wire name, "unconfirmed" is what a reader is told. Only on an explicit `false` — an
          // absent verdict is unknown, not unconfirmed, and saying otherwise would accuse a close
          // nobody recorded anything about.
          (l.verified === false ? ' — unconfirmed' : '') +
          // ADR 283: and WHY. `unconfirmed` alone sends every reader the same way; these two halves
          // send them opposite ways, so the reason rides wherever the word does.
          (l.close_reason !== undefined && closeReasonCopy(l.close_reason) !== null
            ? ` (${closeReasonCopy(l.close_reason)!})`
            : ''),
      );
  }
  if (b.next_goal) {
    const g = b.next_goal;
    lines.push(`\nnext goal — ${g.id} "${g.title}"${g.wave !== null ? ` wave=${g.wave}` : ''}`);
    lines.push(`  claim a lane on it: lane_open {title, goal_id:"${g.id}", claim:true}`);
  }
  if (b.why) {
    // Dated on purpose (ADR 264). This line is read as a standing instruction, and until the age
    // was shown the only way to catch a dead one was to notice its content had gone stale — which
    // took 15 days the last time, and 38 for the copy 19 other seats were reading.
    lines.push(
      `\nwhy — handoff from ${b.why.from}${b.why.goal_id ? ` goal=${b.why.goal_id}` : ''}` +
        ` (${shortDuration(Math.max(0, Date.now() - b.why.ts))} ago):`,
    );
    lines.push('  ' + b.why.body);
  }
  if (
    !goals.length &&
    !owed.length &&
    !b.in_flight.length &&
    !b.up_next.length &&
    !b.shipped.length &&
    !b.next_goal &&
    !b.why
  ) {
    lines.push('nothing in flight — lane_open {title, claim:true} to declare your work');
  }
  return lines.join('\n');
}
