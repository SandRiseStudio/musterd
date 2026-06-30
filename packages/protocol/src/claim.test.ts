import { describe, expect, it } from 'vitest';
import {
  autoClaims,
  BindingSchema,
  formatClaimPolicy,
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
  it('carries the resolved seat (v0.3, ADR 075 — no member/token)', () => {
    expect(ResolvedSessionSchema.parse({ seat: 'Ada' })).toEqual({ seat: 'Ada' });
    expect(() => ResolvedSessionSchema.parse({})).toThrow();
    expect(() => ResolvedSessionSchema.parse({ seat: '' })).toThrow();
  });
});

describe('BindingSchema (P3 v0.3, ADR 075) — agent_key + claim policy, no member/token', () => {
  it('auto-claims when agent_key + a seat policy are present', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      agent_key: 'mskey_x',
      surface: 'cli',
      claim: { mode: 'seat', name: 'Ada' },
    });
    expect(autoClaims(b)).toBe(true);
  });

  it('auto-claims a role-pool policy (role is non-chat)', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      agent_key: 'mskey_x',
      surface: 'claude-code',
      claim: { mode: 'role', role: 'backend' },
    });
    expect(autoClaims(b)).toBe(true);
    expect(b.claim).toEqual({ mode: 'role', role: 'backend' });
  });

  it('does NOT auto-claim a chat policy (assign-in-chat)', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      agent_key: 'mskey_x',
      surface: 'cli',
      claim: { mode: 'chat' },
    });
    expect(autoClaims(b)).toBe(false);
  });

  it('does NOT auto-claim without an agent_key (human/chat folder)', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'web',
      claim: { mode: 'seat', name: 'Ada' },
    });
    expect(autoClaims(b)).toBe(false);
  });

  it('does NOT auto-claim without a claim policy', () => {
    const b = BindingSchema.parse({
      server: 'http://localhost:4849',
      team: 'dawn',
      agent_key: 'mskey_x',
      surface: 'cli',
    });
    expect(autoClaims(b)).toBe(false);
  });
});
