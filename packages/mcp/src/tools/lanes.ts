import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Lane, LaneWarning } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

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
  return `${l.id} [${l.state}] "${l.title}" — owner=${owner} project=${l.project}${surface}${deps}${branch}`;
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

export function registerLanes(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'lane_open',
    {
      description:
        'Open a lane — declare a unit of work (title + the paths it will touch + what it builds on). ' +
        'Set claim=true to own it yourself (the usual task-start move). Returns the lane + any ' +
        'contention warnings (unmet dependency / surface overlap) — advisory, never blocking.',
      inputSchema: {
        title: z.string().describe('the work-item, short'),
        detail: z.string().optional().describe('acceptance criteria / notes'),
        project: z.string().optional().describe('surface-space scope; defaults to "default"'),
        surface_globs: z
          .array(z.string())
          .optional()
          .describe('declared paths, e.g. ["packages/server/src/store/**"]'),
        depends_on: z.array(z.string()).optional().describe('lane ids this lane builds on'),
        branch: z.string().optional().describe('git branch carrying the work'),
        role: z.string().optional().describe('assignment hint (advisory)'),
        claim: z.boolean().optional().describe('own it yourself now (recommended at task start)'),
      },
    },
    async (args) => {
      try {
        const { lane, warnings } = await client.openLane(args);
        return textResult(fmtResult('lane opened', lane, warnings));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'lane_claim',
    {
      description:
        'Take ownership of an open lane. Runs the contention checks; returns the lane + warnings.',
      inputSchema: { id: z.string().describe('lane id') },
    },
    async (args) => {
      try {
        if (!client.member) return textResult('claim a seat first (team_join)');
        const { lane, warnings } = await client.updateLane(args.id, {
          owner_seat: client.member,
        });
        return textResult(fmtResult('lane claimed', lane, warnings));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'lane_board',
    {
      description:
        'The lane board — who owns what, in what state, with live contention warnings. Pull this at ' +
        'task start and before picking up new work (the roster says who is present; the board says ' +
        'who owns what).',
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
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'lane_handoff',
    {
      description:
        'Transfer a lane to another seat, carrying the branch — the work arrives as an artifact the ' +
        'recipient builds on, not a description they re-derive. The recipient gets a directed wake.',
      inputSchema: {
        id: z.string().describe('lane id'),
        to: z.string().describe('recipient seat name'),
        branch: z.string().optional().describe('the branch/artifact carrying the work'),
      },
    },
    async (args) => {
      try {
        const { lane, warnings } = await client.updateLane(args.id, {
          owner_seat: args.to,
          ...(args.branch ? { branch: args.branch } : {}),
        });
        return textResult(fmtResult(`lane handed to ${args.to}`, lane, warnings));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'lane_update',
    {
      description:
        'Update a lane — state (active/blocked/…), surface, dependencies, branch, detail. Going ' +
        'active re-runs the contention checks.',
      inputSchema: {
        id: z.string().describe('lane id'),
        state: z
          .enum(['open', 'claimed', 'active', 'blocked', 'done', 'abandoned'])
          .optional()
          .describe('new state'),
        detail: z.string().optional(),
        surface_globs: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        branch: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const { id, ...patch } = args;
        const { lane, warnings } = await client.updateLane(id, patch);
        return textResult(fmtResult('lane updated', lane, warnings));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'lane_resolve',
    {
      description:
        'Mark a lane done — closure as a state transition, not a courtesy message. Clears its ' +
        'warnings and releases its surface.',
      inputSchema: { id: z.string().describe('lane id') },
    },
    async (args) => {
      try {
        const { lane, warnings } = await client.updateLane(args.id, { state: 'done' });
        return textResult(fmtResult('lane done', lane, warnings));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
