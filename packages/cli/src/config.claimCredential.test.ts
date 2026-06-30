import { describe, expect, it } from 'vitest';
import { claimCredentialFromEnv } from './config.js';

const base = {
  MUSTERD_TEAM: 'dawn',
  MUSTERD_AGENT_KEY: 'mskey_x',
  MUSTERD_CLAIM: 'seat:Ada',
  MUSTERD_SURFACE: 'cli',
};

describe('claimCredentialFromEnv (ADR 075 Decision 1)', () => {
  it('reads the v0.3 triple + resolves a seat target', () => {
    const r = claimCredentialFromEnv(base);
    expect(r).not.toBeNull();
    expect(r!.team).toBe('dawn');
    expect(r!.credential.agentKey).toBe('mskey_x');
    expect(r!.credential.target).toEqual({ seat: 'Ada' });
    expect(r!.credential.surface).toBe('cli');
    expect(r!.credential.grant).toBeUndefined();
  });

  it('parses role + observe targets', () => {
    expect(
      claimCredentialFromEnv({ ...base, MUSTERD_CLAIM: 'role:backend' })!.credential.target,
    ).toEqual({
      role: 'backend',
    });
    expect(
      claimCredentialFromEnv({ ...base, MUSTERD_CLAIM: 'observe' })!.credential.target,
    ).toEqual({
      observe: true,
    });
  });

  it('carries the optional grant', () => {
    const r = claimCredentialFromEnv({ ...base, MUSTERD_GRANT: 'msgr_y' });
    expect(r!.credential.grant).toBe('msgr_y');
  });

  it('defaults surface to cli', () => {
    const r = claimCredentialFromEnv({
      MUSTERD_TEAM: 'dawn',
      MUSTERD_AGENT_KEY: 'mskey_x',
      MUSTERD_CLAIM: 'seat:Ada',
    });
    expect(r!.credential.surface).toBe('cli');
  });

  it('returns null when a required var is missing', () => {
    expect(claimCredentialFromEnv({ ...base, MUSTERD_AGENT_KEY: undefined })).toBeNull();
    expect(claimCredentialFromEnv({ ...base, MUSTERD_CLAIM: undefined })).toBeNull();
    expect(claimCredentialFromEnv({ ...base, MUSTERD_TEAM: undefined })).toBeNull();
  });

  it('returns null when MUSTERD_CLAIM does not parse', () => {
    expect(claimCredentialFromEnv({ ...base, MUSTERD_CLAIM: 'garbage' })).toBeNull();
  });
});
