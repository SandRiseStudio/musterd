/**
 * The canonical list of MCP tool names `buildMcpServer` registers (ADR 085). Kept in its own tiny,
 * dependency-free module so the guidance drift check (`scripts/check-guidance.ts`) can import it
 * without pulling in the MCP SDK. `mcp.test.ts` asserts this equals the built server's actual registry,
 * and `pnpm guidance:check` asserts the skill's `SKILL_MCP_TOOLS` is a subset of it — so renaming a
 * tool without updating the skill breaks the build.
 */
export const TOOL_NAMES = [
  'team_join',
  'team_leave',
  'team_send',
  'team_inbox_check',
  'team_status',
  'team_members',
  'team_memory_save',
  'team_memory_read',
  'lane_open',
  'lane_claim',
  'lane_handoff',
  'lane_update',
  'lane_resolve',
  'lane_board',
  'team_next',
  'team_goal_declare',
  'team_goals',
  'team_report',
] as const;
