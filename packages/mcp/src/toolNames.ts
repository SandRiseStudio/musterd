/**
 * The canonical list of MCP tool names `buildMcpServer` registers (ADR 085). Kept in its own tiny,
 * dependency-free module so the guidance drift check (`scripts/check-guidance.ts`) can import it
 * without pulling in the MCP SDK. `mcp.test.ts` asserts this equals the built server's actual registry,
 * and `pnpm guidance:check` asserts the skill's `SKILL_MCP_TOOLS` is a subset of it — so renaming a
 * tool without updating the skill breaks the build.
 *
 * Naming convention (ADR 144 inc 2 — the audited standard): `<namespace>_<operation>`, with exactly
 * two DELIBERATE namespaces. `team_*` is the coordination surface — presence, acts, Seeds, goals,
 * memory, insight. `lane_*` is the work-board sub-surface — a Lane's lifecycle. The
 * split is intentional, not drift: MCP spec issue #2808's namespacing proposal favors several small
 * namespaces over one flat prefix, and folding lanes into `team_lane_*` would lengthen every name
 * and break connected agents for no selection gain. New tools join one of these namespaces or argue
 * a third in an ADR; operations are a verb (`join`, `send`, `resolve`) or the noun they read
 * (`status`, `board`, `goals`).
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
  'team_wake_context',
  'team_seed_list',
  'team_seed_get',
  'team_seed_update',
  'lane_open',
  'lane_claim',
  'lane_release',
  'lane_handoff',
  'lane_update',
  'lane_submit',
  'lane_ready',
  'lane_resolve',
  'lane_board',
  'team_next',
  'team_goal_declare',
  'team_goal_outcome',
  'team_goal_retract',
  'team_goals',
  'team_report',
  'team_insight_save',
  'team_insight_search',
  'team_memory_search', // deprecated alias — remove after one epoch (ADR 296)
] as const;
