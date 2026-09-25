import { describe, expect, it } from 'vitest';
import {
  claudeProjectMove,
  claudeProjectSlug,
  mapPath,
  memberMoves,
  rewriteJson,
  rewritePaths,
  rewriteRegistry,
  teamRoots,
  underRoof,
} from './plan.ts';

const home = '/Users/nick';
const bindings = {
  '/Users/nick/musterd/agents/dolly': { team: 'revive', seat: 'dolly' },
  '/Users/nick/musterd/agents/nick': { team: 'revive', seat: 'nick' },
  '/Users/nick/musterd/site/june': { team: 'other', seat: 'june' },
  '/Users/nick/musterd/other/site/kim': { team: 'other', seat: 'kim' }, // already team-first
  '/Users/nick/musterd/revive': { team: 'revive', seat: 'nick' }, // the ADR 176 team home
  '/Users/nick/.musterd/runtime/.worktrees/x': { team: 'revive', seat: 'x' }, // not the layout's
};
const mapping = memberMoves(home, bindings);

describe('team-first layout mapping (ADR 447)', () => {
  it('moves every repo-first member Workspace under its team; leaves the rest', () => {
    expect(mapping.get('/Users/nick/musterd/agents/dolly')).toBe(
      '/Users/nick/musterd/revive/agents/dolly',
    );
    expect(mapping.get('/Users/nick/musterd/agents/nick')).toBe(
      '/Users/nick/musterd/revive/agents/nick',
    );
    expect(mapping.get('/Users/nick/musterd/site/june')).toBe(
      '/Users/nick/musterd/other/site/june',
    );
    expect(mapping.has('/Users/nick/musterd/other/site/kim')).toBe(false);
    expect(mapping.has('/Users/nick/musterd/revive')).toBe(false);
    expect(mapping.has('/Users/nick/.musterd/runtime/.worktrees/x')).toBe(false);
  });

  it('names the team roots whose binding goes', () => {
    expect(teamRoots(home, bindings)).toEqual([
      '/Users/nick/musterd/other',
      '/Users/nick/musterd/revive',
    ]);
    expect(underRoof(home, '/Users/nick/musterd/revive/agents/dolly')).toEqual([
      'revive',
      'agents',
      'dolly',
    ]);
    expect(underRoof(home, '/Users/nick/elsewhere')).toBeNull();
  });
});

describe('path rewriting is segment-bounded', () => {
  it('mapPath moves a folder and its descendants, never a look-alike sibling', () => {
    expect(mapPath('/Users/nick/musterd/agents/dolly/.musterd/binding.json', mapping)).toBe(
      '/Users/nick/musterd/revive/agents/dolly/.musterd/binding.json',
    );
    expect(mapPath('/Users/nick/musterd/agents/dolly-x', mapping)).toBe(
      '/Users/nick/musterd/agents/dolly-x',
    );
    expect(mapPath('/Users/nick/musterd/agents', mapping)).toBe('/Users/nick/musterd/agents');
  });

  it('rewritePaths rewrites inside text with the same boundary rule', () => {
    // NUL-separated ledger keys and a look-alike that must survive untouched.
    expect(rewritePaths('folder\u0000/Users/nick/musterd/agents/dolly\u0000codex', mapping)).toBe(
      'folder\u0000/Users/nick/musterd/revive/agents/dolly\u0000codex',
    );
    expect(rewritePaths('/Users/nick/musterd/agents/dolly-x/y', mapping)).toBe(
      '/Users/nick/musterd/agents/dolly-x/y',
    );
  });

  it('rewriteJson rewrites keys and values, deeply', () => {
    const doc = {
      projects: {
        '/Users/nick/musterd/agents/dolly': {
          mcpServers: {
            musterd: { args: ['/Users/nick/.musterd/runtime/packages/mcp/dist/index.js'] },
          },
        },
      },
      githubRepoPaths: { 'SandRiseStudio/musterd': ['/Users/nick/musterd/agents/nick'] },
    };
    expect(rewriteJson(doc, mapping)).toEqual({
      projects: {
        '/Users/nick/musterd/revive/agents/dolly': {
          mcpServers: {
            musterd: { args: ['/Users/nick/.musterd/runtime/packages/mcp/dist/index.js'] },
          },
        },
      },
      githubRepoPaths: { 'SandRiseStudio/musterd': ['/Users/nick/musterd/revive/agents/nick'] },
    });
  });
});

describe('registry and transcripts', () => {
  it('re-keys member bindings, drops the team roots, and moves teamHome off the root to the human', () => {
    const next = rewriteRegistry(
      { bindings, teamHome: { revive: '/Users/nick/musterd/revive' } },
      home,
      mapping,
    );
    expect(next.bindings).toEqual({
      '/Users/nick/musterd/revive/agents/dolly': { team: 'revive', seat: 'dolly' },
      '/Users/nick/musterd/revive/agents/nick': { team: 'revive', seat: 'nick' },
      '/Users/nick/musterd/other/site/june': { team: 'other', seat: 'june' },
      '/Users/nick/musterd/other/site/kim': { team: 'other', seat: 'kim' },
      '/Users/nick/.musterd/runtime/.worktrees/x': { team: 'revive', seat: 'x' },
    });
    expect(next.teamHome).toEqual({ revive: '/Users/nick/musterd/revive/agents/nick' });
  });

  it('claudeProjectSlug matches Claude Code, and a moved project folder moves its transcripts', () => {
    expect(claudeProjectSlug('/Users/nick/musterd/agents/dolly')).toBe(
      '-Users-nick-musterd-agents-dolly',
    );
    const projects = '/Users/nick/.claude/projects';
    expect(claudeProjectMove(`${projects}/-Users-nick-musterd-agents-dolly`, mapping)).toBe(
      `${projects}/-Users-nick-musterd-revive-agents-dolly`,
    );
    expect(claudeProjectMove(`${projects}/-Users-nick-elsewhere`, mapping)).toBeNull();
  });
});
