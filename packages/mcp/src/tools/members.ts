import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, formatMember, textResult } from './format.js';

const DESCRIPTION =
  'Detail on one member (or all): current work, model, roles, presence. Filter by role to find ' +
  'who holds a duty ("who is platform?"). Use to pick who to hand off to or ask for help.';

export function registerMembers(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_members',
    {
      description: DESCRIPTION,
      inputSchema: {
        name: z.string().optional().describe('member name; omit for all'),
        role: z
          .string()
          .optional()
          .describe('filter to seats holding this role (ADR 227 discovery)'),
      },
    },
    async (args) => {
      try {
        const { members, roles } = await client.roster();
        let selected = args.name ? members.filter((m) => m.name === args.name) : members;
        if (args.role) selected = selected.filter((m) => (m.roles ?? []).includes(args.role!));
        if (selected.length === 0) {
          if (args.role) {
            // Name what DOES exist — the next query should not need a second round-trip.
            const known = (roles ?? []).map((r) => r.name);
            return textResult(
              `no seat holds role "${args.role}"` +
                (known.length
                  ? ` — team roles: ${known.join(', ')}`
                  : ' — this team defines no roles'),
            );
          }
          return textResult(
            args.name
              ? `no member "${args.name}" — team_status lists the roster`
              : 'no members yet — team_join claims your seat',
          );
        }
        // The shared member line (what they're doing, model, where) — the substance an agent decides on.
        // A member with several presences is the one case this tool must say more than the roster does:
        // it is the "detail on one member" tool, so the extra surfaces are appended rather than dropped.
        const lines = selected.map((m) => {
          let line = formatMember(m);
          const extra = m.presences.slice(1);
          if (extra.length)
            line += ` (also ${extra.map((p) => `${p.surface}:${p.status}`).join(', ')})`;
          // The decision-grade busy read (ADR 219), when the daemon serves one — beside wakeable it
          // answers "can I reach this seat, and would reaching it interrupt anything?". `unknown`
          // stays silent (absent-vs-unknown discipline: no signal is not a fact).
          const q = m.quiescence;
          if (q && q.state !== 'unknown') {
            line +=
              q.state === 'quiet' && q.quiet_for_ms != null
                ? ` · quiet ${Math.round(q.quiet_for_ms / 60_000)}m`
                : ` · ${q.state}`;
          }
          return line;
        });
        // A role query leads with the role's own one-line face, when the library carries one.
        if (args.role) {
          const summary = (roles ?? []).find((r) => r.name === args.role)?.summary;
          if (summary) lines.unshift(`${args.role} — ${summary}`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
