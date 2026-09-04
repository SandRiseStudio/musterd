import type { McpServer } from '@modelcontextprotocol/server';
import { type ClaimPolicy } from '@musterd/protocol';
import { z } from 'zod';
import { ClaimConflictError, claimAndJoin, type ClaimTarget } from '../claim.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { repairHint, textResult } from './format.js';
import { memoryLine } from './memory.js';

const DESCRIPTION =
  "Claim your seat and go online — the CLI spelling is `musterd claim` (ADR 075/377). Use as, role, or this Workspace's policy. May wait for approval; pass wait:0 to get the pending handle immediately and keep working.";

/** Default block while waiting for an admin to approve a claim (ADR 087); `wait` overrides it per
 *  call (ADR 095). A later approval still occupies in the background either way — a follow-up
 *  team_join then reports already-joined.
 *
 *  Measured 2026-09-03 on this daemon: of 33 claim requests opened from an MCP surface, 28 could not
 *  be satisfied inside this budget — 18 were decided later than 120s (median ~150s, longest 52min)
 *  and 10 were never decided at all. So the default is the interactive DX, not a wait that usually
 *  works; an autonomous seat should pass `wait: 0`. Falsify: re-run the join in
 *  `docs/wiki/claim-approval-latency.md`. */
const JOIN_WAIT_MS = 120_000;

/** Resolve the `wait` control to a block budget in ms (ADR 095 decision 1). */
export function resolveWaitMs(wait: number | boolean | undefined): number {
  if (wait === undefined || wait === true) return JOIN_WAIT_MS;
  if (wait === false) return 0;
  if (!Number.isFinite(wait) || wait < 0) {
    throw new RangeError('wait must be a non-negative number of seconds (0 = do not block)');
  }
  return Math.round(wait * 1000);
}

function charterBlock(client: MusterdClient): string {
  const charter = client.charter?.trim();
  return charter ? `\n\nYour Team Role charter:\n${charter}` : '';
}

/**
 * Resolve what to claim: explicit `as`/`role` win; else an already-bound identity (back-compat — an
 * `init`-minted seat re-occupies itself); else the folder policy; else ask the session to name itself.
 */
function resolveTarget(
  args: { as?: string | undefined; role?: string | undefined },
  policy: ClaimPolicy,
  currentMember: string | undefined,
): ClaimTarget | { needsName: true } {
  if (args.as) return { seat: args.as };
  if (args.role) return { role: args.role };
  if (currentMember) return { seat: currentMember };
  if (policy.mode === 'seat') return { seat: policy.name };
  if (policy.mode === 'role') return { role: policy.role };
  return { needsName: true };
}

export function registerJoin(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_join',
    {
      description: DESCRIPTION,
      inputSchema: {
        as: z.string().optional().describe('claim this named seat (auto-minted locally if new)'),
        role: z.string().optional().describe('claim the next open seat in this role pool'),
        wait: z
          .union([z.number(), z.boolean()])
          .optional()
          .describe(
            'seconds to block for an admin approval: omitted/true = 120s (interactive default), ' +
              '0/false = do not block — get the request id now, keep working, and occupy in the ' +
              'background when the approval lands',
          ),
      },
    },
    async (args) => {
      if (client.joined) {
        // Still show the continuity pointer (ADR 093): the occupy that delivered it may have happened
        // silently in the background (an admin approval after a team_join timeout, ADR 087), making
        // this confirm call the first place the agent can see it.
        const charter = charterBlock(client);
        const memory = client.memory ? `\n\n${memoryLine(client.memory)}` : '';
        return textResult(`Already joined ${config.team} as ${config.member}.${charter}${memory}`);
      }

      const target = resolveTarget(args, config.claim, config.member);
      if ('needsName' in target) {
        return textResult(
          `You're a pending presence on ${config.team} (unclaimed, code ${config.claimCode}) — ` +
            `you hold no seat yet. Name yourself to claim one: team_join {as:'Ada'} for a named seat, ` +
            `or team_join {role:'backend'} for the next open pool seat. (A human can also run ` +
            `\`musterd claim <name>\` from this folder.)`,
        );
      }

      // Claim the seat (mint-or-reuse, local auto-mint), then occupy it — blocking through one
      // approval, unless the caller set its own budget with `wait` (ADR 095).
      let waitMs: number;
      try {
        waitMs = resolveWaitMs(args.wait);
      } catch (err) {
        return textResult(`Can't join: ${(err as Error).message}`);
      }
      try {
        const result = await claimAndJoin(client, config, target, waitMs);
        if (result.pending) {
          const req = result.pending.requestId;
          const decide = req
            ? `Ask an admin to run \`musterd requests decide ${req} --approve\`.`
            : 'Ask an admin to approve the claim.';
          return textResult(
            `Claim opened on ${config.team} for ${result.member}${req ? ` — request ${req}` : ''} ` +
              `(awaiting admin approval). You are NOT seated yet, so do not act as that seat. ` +
              `${decide} You did not have to wait for it: keep working, and the seat occupies ` +
              `automatically the moment the approval lands. Call team_join again to confirm you are live.`,
          );
        }
        const role = 'role' in target ? ` (role ${target.role})` : '';
        const charter = charterBlock(client);
        // The continuity one-liner (ADR 093 §3): at most one line — headline + age, never the body.
        const memory = client.memory ? `\n\n${memoryLine(client.memory)}` : '';
        return textResult(
          `Joined ${config.team} as ${result.member}${role} (${config.surface}). ` +
            `You are now the live occupant of this seat — that's who you are on this team. ` +
            `The server authenticated this occupancy.${charter}${memory}\n\n` +
            `IMPORTANT — stay in sync: call team_inbox_check now, then again whenever you finish a ` +
            `task or a reply. Report progress with team_send {act:'status_update'}; hand work off ` +
            `with {act:'handoff'}.`,
        );
      } catch (err) {
        if (err instanceof ClaimConflictError) {
          const free = err.claimable.length ? ` On the team: ${err.claimable.join(', ')}.` : '';
          return textResult(`Can't claim that seat — ${err.message}${free}`);
        }
        // Still parked on an approval request when the wait elapsed (ADR 087): the claim is open and the
        // seat occupies automatically once an admin approves — no need to re-open a request.
        const reqId = client.awaitingRequestId;
        if (reqId) {
          return textResult(
            `Waiting on admin approval to claim your seat on ${config.team} — request ${reqId}. ` +
              `Ask an admin to run \`musterd requests decide ${reqId} --approve\`. You'll occupy the ` +
              `seat automatically the moment they do; call team_join again to confirm you're live.`,
          );
        }
        const message = (err as Error).message;
        return textResult(`Could not join ${config.team}: ${message}${repairHint(message)}`);
      }
    },
  );
}
