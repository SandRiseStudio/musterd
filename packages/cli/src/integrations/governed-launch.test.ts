import type { GovernedLaunchAuthorizationMint } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { buildGovernedLaunchPlan } from './governed-launch.js';

const mint: GovernedLaunchAuthorizationMint = {
  authorization: {
    id: '01JLAUNCH',
    team: 'revive',
    member: 'Ada',
    node_id: '01JNODE',
    correlation: 'corr-1',
    context: { kind: 'lane', lane_id: '01JLANE' },
    issued_by: 'Nick',
    created_at: 1_000,
    expires_at: 301_000,
    consumed_at: null,
    revoked_at: null,
    presence_id: null,
  },
  token: 'msla_test-token',
};

const baseEnv = {
  HOME: '/home/ada',
  PATH: '/usr/bin:/bin',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  CLAUDE_CONFIG_DIR: '/tmp/claude',
  CODEX_HOME: '/tmp/codex',
  OPENAI_API_KEY: 'sk-live-openai',
  ANTHROPIC_API_KEY: 'sk-live-anthropic',
  HTTPS_PROXY: 'https://user:password@example.test',
  UNRELATED: 'drop-me',
};

const input = (harness: 'claude-code' | 'codex') => ({
  harness,
  server: 'https://musterd.example.test',
  team: 'revive',
  agentKey: 'mskey_team-secret',
  apertureBaseUrl: 'https://aperture.example.test/v1',
  model: 'anthropic/claude-sonnet-4-5',
  workspace: '/work/agents-big-body',
  launch: mint,
  baseEnv,
});

describe('buildGovernedLaunchPlan', () => {
  it('builds a Claude Code plan with the Aperture endpoint and no direct provider keys', () => {
    const plan = buildGovernedLaunchPlan(input('claude-code'));

    expect(plan).toMatchObject({
      harness: 'claude-code',
      command: 'claude',
      args: ['--model', 'anthropic/claude-sonnet-4-5'],
    });
    expect(plan.env).toMatchObject({
      HOME: '/home/ada',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      ANTHROPIC_BASE_URL: 'https://aperture.example.test/v1',
      MUSTERD_SERVER: 'https://musterd.example.test',
      MUSTERD_TEAM: 'revive',
      MUSTERD_AGENT_KEY: 'mskey_team-secret',
      MUSTERD_CLAIM: 'seat:Ada',
      MUSTERD_LAUNCH_SURFACE: 'claude-code',
      MUSTERD_GOVERNED_LAUNCH_ID: '01JLAUNCH',
      MUSTERD_GOVERNED_LAUNCH_TOKEN: 'msla_test-token',
      MUSTERD_GOVERNED_NODE_ID: '01JNODE',
      MUSTERD_GOVERNED_CORRELATION: 'corr-1',
      MUSTERD_GOVERNED_APERTURE_BASE_URL: 'https://aperture.example.test/v1',
    });
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.HTTPS_PROXY).toBeUndefined();
    expect(plan.env.UNRELATED).toBeUndefined();
    expect(plan.env.CODEX_HOME).toBeUndefined();
  });

  it('builds a Codex plan with the documented command and endpoint variable', () => {
    const plan = buildGovernedLaunchPlan(input('codex'));

    expect(plan).toMatchObject({
      harness: 'codex',
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--model',
        'anthropic/claude-sonnet-4-5',
        '-C',
        '/work/agents-big-body',
      ],
    });
    expect(plan.env.OPENAI_BASE_URL).toBe('https://aperture.example.test/v1');
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plan.env.CODEX_HOME).toBe('/tmp/codex');
    expect(plan.env.MUSTERD_LAUNCH_SURFACE).toBe('codex');
  });

  it('rejects unsupported harnesses before building a child environment', () => {
    expect(() => buildGovernedLaunchPlan({ ...input('codex'), harness: 'cursor' })).toThrow(
      /only claude-code or codex/,
    );
  });

  it('fails closed for invalid URLs and allows loopback HTTP for local testing', () => {
    expect(() =>
      buildGovernedLaunchPlan({
        ...input('codex'),
        apertureBaseUrl: 'http://aperture.example.test',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      buildGovernedLaunchPlan({
        ...input('codex'),
        apertureBaseUrl: 'https://user:password@aperture.example.test',
      }),
    ).toThrow(/userinfo/);
    expect(
      buildGovernedLaunchPlan({ ...input('codex'), apertureBaseUrl: 'http://127.0.0.1:8787' }).env
        .OPENAI_BASE_URL,
    ).toBe('http://127.0.0.1:8787');
  });

  it('rejects a non-prefixed agent key, malformed handoff, and floating model', () => {
    expect(() => buildGovernedLaunchPlan({ ...input('codex'), agentKey: 'sk-direct' })).toThrow(
      /agent key/,
    );
    expect(() =>
      buildGovernedLaunchPlan({
        ...input('codex'),
        launch: { ...mint, token: 'not-a-launch-token' },
      }),
    ).toThrow();
    expect(() => buildGovernedLaunchPlan({ ...input('codex'), model: 'anthropic/latest' })).toThrow(
      /model/,
    );
  });
});
