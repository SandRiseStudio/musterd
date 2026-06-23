import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ClaimPolicy } from '@musterd/protocol';
import { z } from 'zod';
import { ClaimConflictError, claimAndJoin, type ClaimTarget } from '../claim.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Claim a seat on your team and go online — call this once when you start working. ' +
  'Overloaded (claim-on-first-use): {as:"Ada"} claims a named seat (auto-minted if new); ' +
  '{role:"backend"} claims the next open seat in a role pool (e.g. backend-2); {} uses this ' +
  "folder's claim policy. The result tells you who you are. Until you claim you are a pending " +
  'presence — reachable, but you cannot send or check your inbox. After joining, check your inbox.';

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
        return textResult(`Already joined ${config.team} as ${config.member}.`);
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

      // Claim the seat (mint-or-reuse, local auto-mint), then occupy it.
      try {
        const result = await claimAndJoin(client, config, target);
        const role = 'role' in target ? ` (role ${target.role})` : '';
        return textResult(
          `Joined ${config.team} as ${result.member}${role} (${config.surface}). ` +
            `You are now the live occupant of this seat — that's who you are on this team. ` +
            `Your charter + the team working-loop are in AGENTS.md in this folder.\n\n` +
            `IMPORTANT — stay in sync: call team_inbox_check now, then again whenever you finish a ` +
            `task or a reply. Report progress with team_send {act:'status_update'}; hand work off ` +
            `with {act:'handoff'}.`,
        );
      } catch (err) {
        if (err instanceof ClaimConflictError) {
          const free = err.claimable.length ? ` On the team: ${err.claimable.join(', ')}.` : '';
          return textResult(`Can't claim that seat — ${err.message}${free}`);
        }
        return textResult(`Could not join ${config.team}: ${(err as Error).message}`);
      }
    },
  );
}
