import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ClaimPolicy } from '@musterd/protocol';
import { z } from 'zod';
import { ClaimConflictError, claimAndJoin, type ClaimTarget } from '../claim.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';
import { memoryLine } from './memory.js';

const DESCRIPTION =
  'Claim your seat on the team and go online — call once when you start working. ' +
  '{as:"Ada"} claims a named seat (auto-minted if new); {role:"backend"} claims the next open ' +
  "seat in that pool; {} uses this folder's claim policy. Blocks until an admin approves when " +
  'approval is needed, so one call gets you seated. After joining, check your inbox.';

/** How long team_join blocks waiting for an admin to approve a claim before returning (ADR 087). A
 *  later approval still occupies in the background — a follow-up team_join then reports already-joined. */
const JOIN_WAIT_MS = 120_000;

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
      },
    },
    async (args) => {
      if (client.joined) {
        // Still show the continuity pointer (ADR 093): the occupy that delivered it may have happened
        // silently in the background (an admin approval after a team_join timeout, ADR 087), making
        // this confirm call the first place the agent can see it.
        const memory = client.memory ? ` ${memoryLine(client.memory)}` : '';
        return textResult(`Already joined ${config.team} as ${config.member}.${memory}`);
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

      // Claim the seat (mint-or-reuse, local auto-mint), then occupy it — blocking through one approval.
      try {
        const result = await claimAndJoin(client, config, target, JOIN_WAIT_MS);
        const role = 'role' in target ? ` (role ${target.role})` : '';
        // The continuity one-liner (ADR 093 §3): at most one line — headline + age, never the body.
        const memory = client.memory ? `\n\n${memoryLine(client.memory)}` : '';
        return textResult(
          `Joined ${config.team} as ${result.member}${role} (${config.surface}). ` +
            `You are now the live occupant of this seat — that's who you are on this team. ` +
            `Your charter + the team working-loop are in AGENTS.md in this folder.${memory}\n\n` +
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
        return textResult(`Could not join ${config.team}: ${(err as Error).message}`);
      }
    },
  );
}
