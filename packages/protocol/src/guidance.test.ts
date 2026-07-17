import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GUIDANCE_CONTENT_VERSION,
  GUIDANCE_STAMP_PREFIX,
  parseContentStamp,
  renderContentStamp,
  renderSkillBody,
  renderSkillFrontmatter,
  renderSlashCommand,
  SKILL_CLI_COMMANDS,
  SKILL_MCP_TOOLS,
} from './guidance.js';
import { renderPrimer } from './primer.js';

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
  };

  it('the rendered content matches the snapshot for the current version (bump on change)', () => {
    const rendered = [
      renderSkillBody({ team: 'dawn' }),
      renderSkillFrontmatter('claude-code'),
      renderSkillFrontmatter('cursor'),
      renderSlashCommand('standup'),
      renderSlashCommand('handoff'),
      renderSlashCommand('claim'),
    ].join('\n---\n');
    const hash = createHash('sha256').update(rendered).digest('hex').slice(0, 16);
    expect(SNAPSHOTS[GUIDANCE_CONTENT_VERSION]).toBeDefined();
    expect(hash).toBe(SNAPSHOTS[GUIDANCE_CONTENT_VERSION]);
  });
});

describe('primer is the loop kernel (ADR 085)', () => {
  const primer = renderPrimer({ member: 'Ada', team: 'dawn' });

  it('stays short and points at the skill for depth', () => {
    // The always-loaded block should be a kernel, not a manual.
    const lines = primer.split('\n').length;
    expect(lines).toBeLessThan(35);
    expect(primer).toContain('musterd skill');
    expect(primer).toContain('.claude/skills/musterd/SKILL.md');
  });
});
