import type { McpServer } from '@modelcontextprotocol/server';
import { AvailabilityStatusSchema } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

const DESCRIPTION =
  "Set your OWN availability (ADR 044): 'available', 'away' (holds notifications; pass `until` " +
  "as an ISO time for the roster's \"off until\"), or 'dnd' (only urgent gets through). Explicit " +
  'and self-only — never inferred, never set on your behalf. The CLI twin is `musterd availability`. ' +
  'Added 2026-09-03 (surface survey #1245): agents had no way to say they were away.';

/**
 * `team_availability` — the MCP twin of `musterd availability`. Not a WRITE_TOOL: like join/leave
 * it is the seat's own state, so a muted seat can still say it is away.
 */
export function registerAvailability(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_availability',
    {
      description: DESCRIPTION,
      inputSchema: {
        status: z.enum(['available', 'away', 'dnd']).describe('your availability'),
        until: z
          .string()
          .optional()
          .describe("ISO time you are back — `away` only; the roster shows 'off until <t>'"),
      },
    },
    async (args) => {
      const status = AvailabilityStatusSchema.parse(args.status);
      let until: number | undefined;
      if (args.until !== undefined) {
        if (status !== 'away')
          return textResult('`until` only applies to `away` (the away_until encoding).');
        const ts = Date.parse(args.until);
        if (Number.isNaN(ts)) return textResult(`\`until\` is not a valid date: ${args.until}`);
        until = ts;
      }
      const res = await client.setAvailability({
        status,
        ...(until !== undefined ? { until } : {}),
      });
      const tail = until !== undefined ? ` until ${new Date(until).toISOString()}` : '';
      return textResult(
        `availability set to ${status}${tail} (${res.member.name}). team_status shows it.`,
      );
    },
  );
}
