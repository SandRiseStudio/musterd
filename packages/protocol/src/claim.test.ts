import { describe, expect, it } from 'vitest';
import {
  BindingSchema,
  formatClaimPolicy,
  isClaimed,
  nextRoleHandle,
  parseClaimPolicy,
  ResolvedSessionSchema,
} from './index.js';

describe('parseClaimPolicy (MUSTERD_CLAIM grammar)', () => {
  it('treats unset / empty / "chat" as assign-in-chat', () => {
    expect(parseClaimPolicy(undefined)).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy(null)).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('  ')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('chat')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('CHAT')).toEqual({ mode: 'chat' });
  });

  it('parses seat: and role: forms', () => {
    expect(parseClaimPolicy('seat:Ada')).toEqual({ mode: 'seat', name: 'Ada' });
    expect(parseClaimPolicy(' seat : Ada ')).toEqual({ mode: 'seat', name: 'Ada' });
    expect(parseClaimPolicy('role:backend')).toEqual({ mode: 'role', role: 'backend' });
  });

  it('degrades a malformed value to chat (never throws)', () => {
    expect(parseClaimPolicy('seat:')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('seat:has space')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('garbage')).toEqual({ mode: 'chat' });
    expect(parseClaimPolicy('role:')).toEqual({ mode: 'chat' });
  });

  it('round-trips through formatClaimPolicy', () => {
    for (const raw of ['chat', 'seat:Ada', 'role:backend']) {
      expect(formatClaimPolicy(parseClaimPolicy(raw))).toBe(raw);
    }
  });
});

describe('nextRoleHandle (pool seats)', () => {
  it('returns <role>-1 for an empty pool', () => {
    expect(nextRoleHandle('backend', [])).toBe('backend-1');
  });

  it('skips taken handles and fills the lowest gap', () => {
    expect(nextRoleHandle('backend', ['backend-1'])).toBe('backend-2');
    expect(nextRoleHandle('backend', ['backend-1', 'backend-3'])).toBe('backend-2');
    expect(nextRoleHandle('backend', new Set(['backend-1', 'backend-2']))).toBe('backend-3');
  });

  it('ignores unrelated member names', () => {
    expect(nextRoleHandle('backend', ['Ada', 'frontend-1'])).toBe('backend-1');
  });
});

describe('ResolvedSessionSchema (ADR 034 live-claim channel)', () => {
  it('requires a member and a token', () => {
    expect(ResolvedSessionSchema.parse({ member: 'Ada', token: 'mskd_x' })).toEqual({
      member: 'Ada',
      token: 'mskd_x',
    });
    expect(() => ResolvedSessionSchema.parse({ member: 'Ada' })).toThrow();
    expect(() => ResolvedSessionSchema.parse({ member: '', token: 't' })).toThrow();
  });
});

describe('BindingSchema with optional identity + claim policy (ADR 032)', () => {
  it('accepts a fully-claimed binding (back-compat)', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      member: 'Ada',
      token: 'mskd_x',
      surface: 'cli',
    });
    expect(isClaimed(b)).toBe(true);
  });

  it('accepts a policy-only (unclaimed) binding', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'role', role: 'backend' },
    });
    expect(isClaimed(b)).toBe(false);
    expect(b.claim).toEqual({ mode: 'role', role: 'backend' });
  });

  it('treats member-without-token as unclaimed', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      member: 'Ada',
      surface: 'cli',
    });
    expect(isClaimed(b)).toBe(false);
  });
});
