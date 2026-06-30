import { describe, expect, it } from 'vitest';
import {
  credentialEnv,
  renderAgentEnvBlock,
  renderAgentKeyMint,
  renderGrantMintLabel,
  renderShownOnce,
  renderTeamCreateMint,
} from './credentials.js';

describe('credentialEnv (SPEC A.9, ADR 075 — the spec-pinned core)', () => {
  it('builds the full env string with team + agent key + claim + surface (no grant)', () => {
    expect(
      credentialEnv({
        team: 'dawn',
        agentKey: 'mskey_x',
        claim: 'seat:Ada',
        surface: 'claude-code',
      }),
    ).toBe(
      'MUSTERD_TEAM=dawn MUSTERD_AGENT_KEY=mskey_x MUSTERD_CLAIM=seat:Ada MUSTERD_SURFACE=claude-code',
    );
  });
  it('inserts MUSTERD_GRANT when a grant is supplied', () => {
    expect(
      credentialEnv({
        team: 'dawn',
        agentKey: 'mskey_x',
        claim: 'role:backend',
        grant: 'msgr_y',
        surface: 'codex',
      }),
    ).toBe(
      'MUSTERD_TEAM=dawn MUSTERD_AGENT_KEY=mskey_x MUSTERD_CLAIM=role:backend MUSTERD_GRANT=msgr_y MUSTERD_SURFACE=codex',
    );
  });
  it('accepts the observe claim target', () => {
    expect(
      credentialEnv({
        team: 'dawn',
        agentKey: 'mskey_x',
        claim: 'observe',
        surface: 'claude-code',
      }),
    ).toBe(
      'MUSTERD_TEAM=dawn MUSTERD_AGENT_KEY=mskey_x MUSTERD_CLAIM=observe MUSTERD_SURFACE=claude-code',
    );
  });
  it('orders the vars team → agent key → claim → grant → surface', () => {
    const s = credentialEnv({
      team: 't',
      agentKey: 'k',
      claim: 'seat:A',
      grant: 'g',
      surface: 's',
    });
    expect(s.indexOf('MUSTERD_TEAM=')).toBeLessThan(s.indexOf('MUSTERD_AGENT_KEY='));
    expect(s.indexOf('MUSTERD_AGENT_KEY=')).toBeLessThan(s.indexOf('MUSTERD_CLAIM='));
    expect(s.indexOf('MUSTERD_CLAIM=')).toBeLessThan(s.indexOf('MUSTERD_GRANT='));
    expect(s.indexOf('MUSTERD_GRANT=')).toBeLessThan(s.indexOf('MUSTERD_SURFACE='));
  });
});

describe('renderAgentEnvBlock', () => {
  it('carries the label + the env string', () => {
    const out = renderAgentEnvBlock({
      team: 'dawn',
      agentKey: 'mskey_x',
      claim: 'seat:Ada',
      surface: 'claude-code',
    });
    expect(out).toContain('connect this agent via MCP with env');
    expect(out).toContain(
      'MUSTERD_TEAM=dawn MUSTERD_AGENT_KEY=mskey_x MUSTERD_CLAIM=seat:Ada MUSTERD_SURFACE=claude-code',
    );
  });
});

describe('renderShownOnce', () => {
  it('shows the label + secret + the not-re-fetchable note', () => {
    const out = renderShownOnce('agent key', 'mskey_x');
    expect(out).toContain('agent key: mskey_x');
    expect(out).toContain('shown once');
    expect(out).toContain('cannot be fetched again');
  });
});

describe('renderAgentKeyMint', () => {
  it('shows the agent key once + the env block', () => {
    const out = renderAgentKeyMint({
      team: 'dawn',
      agentKey: 'mskey_x',
      claim: 'seat:Ada',
      surface: 'claude-code',
    });
    expect(out).toContain('agent key: mskey_x');
    expect(out).toContain('MUSTERD_AGENT_KEY=mskey_x');
    expect(out).toContain('MUSTERD_CLAIM=seat:Ada');
  });
});

describe('renderGrantMintLabel', () => {
  it('shows the grant summary + the shown-once token', () => {
    const out = renderGrantMintLabel('msgr_y', 'seat Ada · once');
    expect(out).toContain('grant issued');
    expect(out).toContain('seat Ada · once');
    expect(out).toContain('grant token: msgr_y');
    expect(out).toContain('shown once');
  });
});

describe('renderTeamCreateMint', () => {
  it('renders the team + founding seat + human credential + agent key + env', () => {
    const out = renderTeamCreateMint({
      team: 'dawn',
      seat: { id: 'm1', team: 'dawn', name: 'Ada', kind: 'human', created_at: 1 },
      humanCredential: 'mscr_h',
      agentKey: 'mskey_x',
      claim: 'seat:Ada',
      surface: 'claude-code',
    });
    expect(out).toContain('team "dawn" created');
    expect(out).toContain('human credential: mscr_h');
    expect(out).toContain('agent key: mskey_x');
    expect(out).toContain('MUSTERD_AGENT_KEY=mskey_x');
    expect(out).toContain('MUSTERD_CLAIM=seat:Ada');
  });
});
