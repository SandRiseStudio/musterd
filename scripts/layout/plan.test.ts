import { describe, expect, it } from 'vitest';
import {
  claudeProjectMove,
  claudeProjectSlug,
  defaultLayout,
  legacySeat,
  mapPath,
  pathMapping,
  rewriteJson,
  rewritePaths,
  rewriteRegistry,
} from './plan.ts';

const layout = defaultLayout('/Users/nick');
const mapping = pathMapping(layout, [
  '/Users/nick/agents-dolly',
  '/Users/nick/agents-big-body',
  '/Users/nick/agents-live',
  '/Users/nick/agents-dolly/nested', // not a seat: has a slash
]);

describe('layout mapping (reach spec §6)', () => {
  it('main → unbound runtime, live → the live service home, seats → ~/musterd/<repo>/<seat>', () => {
    expect(mapping.get('/Users/nick/agents')).toBe('/Users/nick/.musterd/runtime');
    expect(mapping.get('/Users/nick/agents-live')).toBe('/Users/nick/.musterd/live/checkout');
    expect(mapping.get('/Users/nick/agents-dolly')).toBe('/Users/nick/musterd/agents/dolly');
    expect(mapping.get('/Users/nick/agents-big-body')).toBe('/Users/nick/musterd/agents/big-body');
    expect(mapping.has('/Users/nick/agents-dolly/nested')).toBe(false);
  });

  it('legacySeat reads the seat off a legacy path and refuses the live worktree', () => {
    expect(legacySeat(layout, '/Users/nick/agents-dolly')).toBe('dolly');
    expect(legacySeat(layout, '/Users/nick/agents-live')).toBeNull();
    expect(legacySeat(layout, '/Users/nick/agents')).toBeNull();
    expect(legacySeat(layout, '/Users/nick/other')).toBeNull();
  });
});

describe('path rewriting is segment-bounded', () => {
  it('mapPath moves a folder and its descendants, never a look-alike sibling', () => {
    expect(mapPath('/Users/nick/agents/packages/cli/dist/bin.js', mapping)).toBe(
      '/Users/nick/.musterd/runtime/packages/cli/dist/bin.js',
    );
    expect(mapPath('/Users/nick/agents-dolly/.musterd/binding.json', mapping)).toBe(
      '/Users/nick/musterd/agents/dolly/.musterd/binding.json',
    );
    expect(mapPath('/Users/nick/agents-fifty', mapping)).toBe('/Users/nick/agents-fifty');
    expect(mapPath('/Users/nick/agentsx', mapping)).toBe('/Users/nick/agentsx');
  });

  it('rewritePaths rewrites inside text with the same boundary rule', () => {
    const plist =
      '<string>/Users/nick/agents/packages/cli/dist/bin.js</string><string>/Users/nick/agents</string>';
    expect(rewritePaths(plist, mapping)).toBe(
      '<string>/Users/nick/.musterd/runtime/packages/cli/dist/bin.js</string><string>/Users/nick/.musterd/runtime</string>',
    );
    // NUL-separated ledger keys and a look-alike that must survive untouched.
    expect(rewritePaths('folder\u0000/Users/nick/agents-dolly\u0000codex', mapping)).toBe(
      'folder\u0000/Users/nick/musterd/agents/dolly\u0000codex',
    );
    expect(rewritePaths('/Users/nick/agents-stanley-izzo/x', mapping)).toBe(
      '/Users/nick/agents-stanley-izzo/x',
    );
  });

  it('rewriteJson rewrites keys and values, so ~/.claude.json projects re-key', () => {
    const claude = {
      projects: {
        '/Users/nick/agents-dolly': { allowedTools: [] },
        '/Users/nick/MoveTrail': {
          mcpServers: { musterd: { args: ['/Users/nick/agents/packages/mcp/dist/index.js'] } },
        },
      },
      githubRepoPaths: {
        'sandrisestudio/musterd': ['/Users/nick/agents-dolly', '/Users/nick/agents'],
      },
    };
    expect(rewriteJson(claude, mapping)).toEqual({
      projects: {
        '/Users/nick/musterd/agents/dolly': { allowedTools: [] },
        '/Users/nick/MoveTrail': {
          mcpServers: {
            musterd: { args: ['/Users/nick/.musterd/runtime/packages/mcp/dist/index.js'] },
          },
        },
      },
      githubRepoPaths: {
        'sandrisestudio/musterd': [
          '/Users/nick/musterd/agents/dolly',
          '/Users/nick/.musterd/runtime',
        ],
      },
    });
  });
});

describe('registry + Claude project folders', () => {
  it('rewriteRegistry re-keys seats and drops the old main: the runtime confers nobody', () => {
    const cfg = {
      server: 'http://127.0.0.1:4849',
      bindings: {
        '/Users/nick/agents': { team: 'revive', seat: 'nick' },
        '/Users/nick/agents-dolly': { team: 'revive', seat: 'dolly' },
        '/Users/nick/musterd/agents/nick': { team: 'revive', seat: 'nick' },
      },
    };
    expect(rewriteRegistry(cfg, layout, mapping).bindings).toEqual({
      '/Users/nick/musterd/agents/dolly': { team: 'revive', seat: 'dolly' },
      '/Users/nick/musterd/agents/nick': { team: 'revive', seat: 'nick' },
    });
  });

  it('claudeProjectSlug matches Claude Code’s folder naming', () => {
    expect(claudeProjectSlug('/Users/nick/agents-dolly')).toBe('-Users-nick-agents-dolly');
    expect(claudeProjectSlug('/private/tmp/claude-501/-Users-nick-agents-miley')).toBe(
      '-private-tmp-claude-501--Users-nick-agents-miley',
    );
    expect(claudeProjectSlug('/Users/nick/.musterd/runtime')).toBe('-Users-nick--musterd-runtime');
  });

  it('a seat’s transcripts follow the seat; the old main’s follow the human', () => {
    const base = '/Users/nick/.claude/projects';
    expect(
      claudeProjectMove(
        `${base}/-Users-nick-agents-dolly`,
        layout,
        mapping,
        '/Users/nick/musterd/agents/nick',
      ),
    ).toBe(`${base}/-Users-nick-musterd-agents-dolly`);
    expect(
      claudeProjectMove(
        `${base}/-Users-nick-agents`,
        layout,
        mapping,
        '/Users/nick/musterd/agents/nick',
      ),
    ).toBe(`${base}/-Users-nick-musterd-agents-nick`);
    expect(claudeProjectMove(`${base}/-Users-nick-other`, layout, mapping, '/x')).toBeNull();
  });
});
