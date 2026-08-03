import { GENERALIST_CAPABILITIES, type Capabilities } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { scopedToolNames, WRITE_TOOLS } from './scope.js';
import { TOOL_NAMES } from './toolNames.js';

/**
 * Scope-by-role (ADR 144 increment 5). The table is declarative data and the projection is pure, so
 * everything here is a table-in / names-out assertion — no server, no SDK.
 */

const muted: Capabilities = { ...GENERALIST_CAPABILITIES, can_message: 'none' };

describe('scopedToolNames (ADR 144 inc 5)', () => {
  it('renders the whole surface for a generalist — the un-governed team is untouched', () => {
    expect(scopedToolNames(GENERALIST_CAPABILITIES)).toEqual([...TOOL_NAMES]);
  });

  it('renders the whole surface when capabilities are unknown (fail-open)', () => {
    // The render is a token-economy lever, NOT the security boundary — the daemon enforces
    // capabilities in-band regardless (route.ts). So an unreadable/absent capability record must
    // degrade to the full surface: a missing tool is a dead end for the agent, while an extra tool
    // it cannot use is merely wasted bytes the server will refuse anyway.
    expect(scopedToolNames(undefined)).toEqual([...TOOL_NAMES]);
  });

  it('drops every acting tool for a muted seat, and keeps every reading one', () => {
    const names = scopedToolNames(muted);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    for (const t of TOOL_NAMES) {
      if (!WRITE_TOOLS.has(t)) expect(names).toContain(t);
    }
  });

  it('keeps a muted observer able to read the board, the roster, and its own orientation', () => {
    const names = scopedToolNames(muted);
    // The point of an observer seat: it watches. These are the tools that make watching possible,
    // and dropping any of them would make the scoped surface useless rather than lean.
    expect(names).toEqual(
      expect.arrayContaining([
        'team_status',
        'team_members',
        'team_inbox_check',
        'lane_board',
        'team_goals',
        'team_report',
        'team_next',
        'team_memory_read',
      ]),
    );
  });

  it('keeps team_join/team_leave for a muted seat — occupancy is not messaging', () => {
    // A muted seat still has to be able to take and release its seat, or it can never come online
    // to observe at all. `can_message` governs ACTS, not presence.
    const names = scopedToolNames(muted);
    expect(names).toContain('team_join');
    expect(names).toContain('team_leave');
  });

  it('preserves registration order, so the cached tools/list stays byte-stable', () => {
    // ADR 175 step 3 advertises ttlMs 1h + cacheScope private; a surface that reorders between
    // renders would churn that cache for no reason. Scoping filters, it never sorts.
    const names = scopedToolNames(muted);
    const expected = TOOL_NAMES.filter((t) => names.includes(t));
    expect(names).toEqual([...expected]);
  });

  it('every WRITE_TOOLS entry is a real registered tool (no drift from the registry)', () => {
    for (const w of WRITE_TOOLS) expect(TOOL_NAMES).toContain(w);
  });

  it('cuts the surface materially for an observer — the increment-5 headline', () => {
    // Measured 2026-08-03 against the built server: 22 tools, including the read-only ADR 209
    // context index; of the original surface the acting
    // tools are 9,876 (77%). The exact byte count belongs to the telemetry attestation, not here;
    // what this pins is that scoping removes at least half, so a regression that quietly stops dropping
    // tools fails loudly.
    const full = scopedToolNames(GENERALIST_CAPABILITIES).length;
    const scoped = scopedToolNames(muted).length;
    expect(scoped).toBeLessThanOrEqual(full / 2);
  });
});
