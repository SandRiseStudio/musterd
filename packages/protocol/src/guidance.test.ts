import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GUIDANCE_CONTENT_VERSION,
  renderOrientFrontmatter,
  renderOrientSkill,
  GUIDANCE_STAMP_PREFIX,
  parseContentStamp,
  renderContentStamp,
  renderLabelSessionsFrontmatter,
  renderLabelSessionsSkill,
  renderNudgeRelayFrontmatter,
  renderNudgeRelaySkill,
  renderSelfLabelSessionFrontmatter,
  renderSelfLabelSessionSkill,
  renderSkillBody,
  renderSkillFrontmatter,
  renderSlashCommand,
  SKILL_CLI_COMMANDS,
  SKILL_MCP_TOOLS,
} from './guidance.js';
import { renderRepositoryPrimer } from './primer.js';

describe('renderSkillBody', () => {
  const body = renderSkillBody({ team: 'dawn' });

  it('names the team and covers the playbook sections', () => {
    expect(body).toContain('dawn');
    expect(body).toContain('## Claiming your seat');
    expect(body).toContain('## Owning work in a lane');
    expect(body).toContain('## Handing off cleanly');
    expect(body).toContain('## Waiting without polling');
    expect(body).toContain('## When something looks wrong');
  });

  it('mentions every name it claims in SKILL_MCP_TOOLS / SKILL_CLI_COMMANDS (drift guard)', () => {
    for (const tool of SKILL_MCP_TOOLS) expect(body).toContain(tool);
    for (const cmd of SKILL_CLI_COMMANDS) expect(body).toContain(`musterd ${cmd}`);
  });

  it('points back at musterd help for flags instead of inlining them', () => {
    expect(body).toContain('musterd help');
  });
});

describe('renderSkillFrontmatter', () => {
  it('gives Claude Code a name + description, Cursor a description + alwaysApply, canonical nothing', () => {
    expect(renderSkillFrontmatter('claude-code')).toContain('name: musterd');
    expect(renderSkillFrontmatter('claude-code')).toContain('description:');
    expect(renderSkillFrontmatter('cursor')).toContain('alwaysApply: false');
    expect(renderSkillFrontmatter('canonical')).toBe('');
  });
});

describe('renderSlashCommand', () => {
  it('renders each command as a thin prompt driving real musterd commands', () => {
    expect(renderSlashCommand('standup')).toContain('musterd status');
    expect(renderSlashCommand('standup')).toContain('musterd next');
    expect(renderSlashCommand('handoff')).toContain('musterd lane handoff');
    expect(renderSlashCommand('claim')).toContain('musterd whoami');
  });
});

describe('content stamp', () => {
  it('round-trips version + hash', () => {
    const stamp = renderContentStamp(GUIDANCE_CONTENT_VERSION, 'abcd1234');
    expect(stamp).toContain(GUIDANCE_STAMP_PREFIX);
    const parsed = parseContentStamp(`some body\n${stamp}\n`);
    expect(parsed).toEqual({ version: GUIDANCE_CONTENT_VERSION, hash: 'abcd1234' });
  });

  it('returns null when no managed stamp is present (user-authored file)', () => {
    expect(parseContentStamp('# my own skill\n')).toBeNull();
  });
});

describe('version-bump discipline (ADR 085)', () => {
  // Snapshot the full rendered guidance surface, keyed by content version. If you change any skill or
  // slash-command prose, this fails — the fix is to BUMP `GUIDANCE_CONTENT_VERSION` and add its new
  // hash below (never just edit the hash at the same version). That is what makes the doctor's
  // stale-version drift check meaningful: a content change always moves the version stamp.
  const SNAPSHOTS: Record<number, string> = {
    1: 'e305d9d43a9f75bb',
    2: 'c580f2a750a4c012', // + seat-memory playbook (ADR 093): save-before-handoff + memory names
    3: 'a9b0672fc52bae70', // + claim-before-build lane rule & ask-stream playbook (ADR 147 inducement)
    4: 'c408be59e7172a1f', // + reachability-gated hold: the STRAND branch of the blocking-ask contract (ADR 153)
    5: 'ba6d7c18cb7ca635', // + label-sessions skill unit + `session` in the command reference (ADR 160)
    6: 'bbeafefcb4cdd58e', // + nudge-relay skill unit (ADR 167)
    7: '131f5f1bfc512501', // + lane_release: park work you stop carrying; the STRAND branch names the verb
    8: 'c01758f70a3e8737', // + where each kind of teammate stands: agents in worktrees, the human in the team home (ADR 176)
    9: '6d3004fc8347d2e4', // + label-sessions: the sweep stamps the machine-wide file that quiets the per-turn label-nudge
    10: '1cd5b6236f2b64d0', // + forever-loop fix prose + Cursor self-label skill (ADR 186)
    11: 'a5bf07c7b3b2c44a', // + outcome acceptance close loop (ADR 192): lane_submit + checklist
    12: '30bf29a8c1e89fc9',
    13: '18db5d31ab51fe37', // + the tick installs when the lockfile moved; a failed tick notifies (pinned, not down) // + daemon refresh: the auto-refresher owns the bounce; never prescribe `service refresh`
    14: '8c1b079d28c39788', // + shared blockers: blocked_by report-and-park + incident convergence (spec 2026-08-14 inc 1)
    15: 'bab60b1f09b5234b', // lane-close step 3 follows ADR 235: backstop armed ⇒ no self-close on silence; self-close stays sanctioned only for nobody-asked / acceptance-exempt (ADR 234)
    16: 'fc1472575867804e', // ADR 296 tier 2: lane_open teaches `scope` (was `surface_globs`)
    17: '0fe7e98a513e636e', // + musterd-orient skill unit + team_wake_context in the tool reference (session-orientation spec 2026-08-25)
    18: 'c5ea40b9c6cdd791', // + team memory: insight save/search + the search-before-you-re-derive playbook (ADR 327)
    19: '3b7db362a4f5eeb9', // + rename team_memory_search → team_insight_search, alias retained one epoch (ADR 327 amendment, ADR 296)
  };

  it('the rendered content matches the snapshot for the current version (bump on change)', () => {
    const rendered = [
      renderSkillBody({ team: 'dawn' }),
      renderSkillFrontmatter('claude-code'),
      renderSkillFrontmatter('cursor'),
      renderSlashCommand('standup'),
      renderSlashCommand('handoff'),
      renderSlashCommand('claim'),
      renderLabelSessionsSkill(),
      renderLabelSessionsFrontmatter(),
      renderSelfLabelSessionSkill(),
      renderSelfLabelSessionFrontmatter(),
      renderNudgeRelaySkill(),
      renderNudgeRelayFrontmatter(),
      renderOrientSkill(),
      renderOrientFrontmatter(),
    ].join('\n---\n');
    const hash = createHash('sha256').update(rendered).digest('hex').slice(0, 16);
    expect(SNAPSHOTS[GUIDANCE_CONTENT_VERSION]).toBeDefined();
    expect(hash).toBe(SNAPSHOTS[GUIDANCE_CONTENT_VERSION]);
  });
});

describe('primer is the loop kernel (ADR 085)', () => {
  const primer = renderRepositoryPrimer({ team: 'dawn' });

  it('stays short and points at the skill for depth', () => {
    // The always-loaded block should be a kernel, not a manual.
    const lines = primer.split('\n').length;
    expect(lines).toBeLessThan(35);
    expect(primer).toContain('musterd skill');
    expect(primer).toContain('.claude/skills/musterd/SKILL.md');
  });
});

describe('skill body — shared-blocker norm (spec 2026-08-14 inc 1)', () => {
  it('teaches blocked_by report-and-park in the on-demand skill, not the primer', () => {
    const body = renderSkillBody({ team: 'revive' });
    expect(body).toContain('meta.blocked_by');
    expect(body).toContain('park behind it');
  });
});

describe('lane-close step 3 follows ADR 235, not the retired self-resolve-on-silence', () => {
  const body = renderSkillBody({ team: 'dawn' });

  it('no longer prescribes unconditional self-resolve on silence', () => {
    expect(body).not.toMatch(/On silence \/ no candidate/);
  });

  it('tells the closer to follow the submit response and names the armed backstop', () => {
    expect(body).toMatch(/follow the submit response/i);
    expect(body).toMatch(/do \*\*not\*\* self-close on silence/i);
    expect(body).toContain('ADR 235');
  });

  it('keeps the sanctioned branches: nobody asked, or acceptance-exempt', () => {
    expect(body).toMatch(/no eligible\s+acceptor/i);
    expect(body).toMatch(/acceptance-exempt/i);
    expect(body).toMatch(/\*\*unconfirmed\*\*, never a wedge/);
  });
});
