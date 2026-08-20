import { describe, expect, it } from 'vitest';
import {
  FragmentLedgerSchema,
  HarnessIdSchema,
  HarnessLockRecordSchema,
  LocalStateIssueSchema,
  ReconcileJournalSchema,
  WorktreeProvisioningSchema,
} from './provisioning.js';

describe('HarnessIdSchema', () => {
  it('accepts registry ids and future ids without a protocol change', () => {
    expect(HarnessIdSchema.safeParse('claude-code').success).toBe(true);
    expect(HarnessIdSchema.safeParse('cursor').success).toBe(true);
    expect(HarnessIdSchema.safeParse('codex').success).toBe(true);
    expect(HarnessIdSchema.safeParse('musterd').success).toBe(true);
    expect(HarnessIdSchema.safeParse('future.harness_2').success).toBe(true);
  });

  it('rejects display names, empty, and oversized ids', () => {
    expect(HarnessIdSchema.safeParse('Claude Code').success).toBe(false);
    expect(HarnessIdSchema.safeParse('').success).toBe(false);
    expect(HarnessIdSchema.safeParse('-leading-dash').success).toBe(false);
    expect(HarnessIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });
});

describe('WorktreeProvisioningSchema (version 2)', () => {
  const provisioning = {
    version: 2 as const,
    profile: 'backend',
    desired: ['claude-code', 'musterd'],
    contributions: {
      'claude-code': ['folder:/w/a:hooks', 'repo:/r:musterd-mcp'],
      musterd: [],
    },
    provisionedAt: '2026-08-19T12:00:00.000Z',
  };

  it('parses the exact version-2 fixture, including an empty generalist role', () => {
    expect(WorktreeProvisioningSchema.parse(provisioning).desired).toEqual([
      'claude-code',
      'musterd',
    ]);
    expect(WorktreeProvisioningSchema.safeParse({ ...provisioning, profile: '' }).success).toBe(
      true,
    );
    expect(WorktreeProvisioningSchema.safeParse({ ...provisioning, desired: [] }).success).toBe(
      true,
    );
  });

  it('accepts an unknown harness id — the registry lives in the CLI, not the schema', () => {
    expect(
      WorktreeProvisioningSchema.safeParse({ ...provisioning, desired: ['future.harness_2'] })
        .success,
    ).toBe(true);
  });

  it('requires desired ids to be unique', () => {
    expect(
      WorktreeProvisioningSchema.safeParse({
        ...provisioning,
        desired: ['claude-code', 'claude-code'],
      }).success,
    ).toBe(false);
  });

  it('rejects version 1, unknown keys, and malformed values', () => {
    expect(WorktreeProvisioningSchema.safeParse({ ...provisioning, version: 1 }).success).toBe(
      false,
    );
    expect(WorktreeProvisioningSchema.safeParse({ ...provisioning, harness: 'x' }).success).toBe(
      false,
    );
    expect(
      WorktreeProvisioningSchema.safeParse({ ...provisioning, desired: ['Not An Id'] }).success,
    ).toBe(false);
    expect(
      WorktreeProvisioningSchema.safeParse({ ...provisioning, provisionedAt: '' }).success,
    ).toBe(false);
  });
});

describe('FragmentLedgerSchema (version 1)', () => {
  const fragment = {
    harness: 'claude-code',
    scope: 'repo-shared' as const,
    containerKey: 'repo:/r:.mcp.json',
    fragmentKey: 'mcpServers.musterd',
    fingerprint: 'a'.repeat(64),
    owners: ['/w/a', '/w/b'],
    adapterVersion: 2,
  };
  const ledger = { version: 1 as const, fragments: { 'repo:/r:.mcp.json#musterd': fragment } };

  it('parses the exact fixture', () => {
    const parsed = FragmentLedgerSchema.parse(ledger);
    expect(parsed.fragments['repo:/r:.mcp.json#musterd']?.owners).toEqual(['/w/a', '/w/b']);
  });

  it('requires owner paths to be unique', () => {
    expect(
      FragmentLedgerSchema.safeParse({
        version: 1,
        fragments: { k: { ...fragment, owners: ['/w/a', '/w/a'] } },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys, unknown scopes, and non-integer adapter versions', () => {
    expect(
      FragmentLedgerSchema.safeParse({
        version: 1,
        fragments: { k: { ...fragment, extra: true } },
      }).success,
    ).toBe(false);
    expect(
      FragmentLedgerSchema.safeParse({
        version: 1,
        fragments: { k: { ...fragment, scope: 'global' } },
      }).success,
    ).toBe(false);
    expect(
      FragmentLedgerSchema.safeParse({
        version: 1,
        fragments: { k: { ...fragment, adapterVersion: 1.5 } },
      }).success,
    ).toBe(false);
  });
});

describe('ReconcileJournalSchema (version 1)', () => {
  const journal = {
    version: 1 as const,
    operationId: '01M0AAAA0000000000000000000',
    action: 'create' as const,
    harness: 'codex',
    containerKey: 'machine:codex-config',
    resourceKey: 'machine:codex-config#musterd-mcp',
    oldFingerprint: null,
    intendedFingerprint: 'b'.repeat(64),
    oldOwners: [],
    intendedOwners: ['/w/a'],
    worktreeRoot: '/w/a',
    phase: 'prepared' as const,
  };

  it('parses the exact fixture with nullable fingerprints', () => {
    expect(ReconcileJournalSchema.parse(journal).oldFingerprint).toBeNull();
    expect(
      ReconcileJournalSchema.safeParse({ ...journal, intendedFingerprint: null }).success,
    ).toBe(true);
  });

  it('fingerprints are nullable only where specified — nothing else is', () => {
    expect(ReconcileJournalSchema.safeParse({ ...journal, harness: null }).success).toBe(false);
    expect(ReconcileJournalSchema.safeParse({ ...journal, oldOwners: null }).success).toBe(false);
    expect(ReconcileJournalSchema.safeParse({ ...journal, worktreeRoot: null }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys, unknown actions, and a non-prepared phase', () => {
    expect(ReconcileJournalSchema.safeParse({ ...journal, extra: 1 }).success).toBe(false);
    expect(ReconcileJournalSchema.safeParse({ ...journal, action: 'adopt' }).success).toBe(false);
    expect(ReconcileJournalSchema.safeParse({ ...journal, phase: 'applied' }).success).toBe(false);
  });
});

describe('HarnessLockRecordSchema (version 1)', () => {
  const lock = {
    version: 1 as const,
    holderId: 'holder-01M0AAAA',
    pid: 4242,
    processStartedAt: 'Tue Aug 19 14:00:00 2026',
    acquiredAt: '2026-08-19T14:00:01.000Z',
    renewedAt: '2026-08-19T14:00:11.000Z',
    expiresAt: '2026-08-19T14:00:31.000Z',
  };

  it('parses the exact fixture', () => {
    expect(HarnessLockRecordSchema.parse(lock).pid).toBe(4242);
  });

  it('requires timestamps, PID, and process-start identity', () => {
    for (const key of [
      'holderId',
      'pid',
      'processStartedAt',
      'acquiredAt',
      'renewedAt',
      'expiresAt',
    ] as const) {
      const { [key]: _dropped, ...rest } = lock;
      expect(HarnessLockRecordSchema.safeParse(rest).success).toBe(false);
    }
    expect(HarnessLockRecordSchema.safeParse({ ...lock, pid: 0 }).success).toBe(false);
    expect(HarnessLockRecordSchema.safeParse({ ...lock, pid: 12.5 }).success).toBe(false);
    expect(HarnessLockRecordSchema.safeParse({ ...lock, processStartedAt: '' }).success).toBe(
      false,
    );
    expect(HarnessLockRecordSchema.safeParse({ ...lock, expiresAt: 'soon' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(HarnessLockRecordSchema.safeParse({ ...lock, note: 'x' }).success).toBe(false);
  });
});

describe('LocalStateIssueSchema', () => {
  it('carries a path and message, never file contents', () => {
    expect(
      LocalStateIssueSchema.parse({ path: 'session.started_at', message: 'expected integer' }),
    ).toEqual({ path: 'session.started_at', message: 'expected integer' });
    expect(
      LocalStateIssueSchema.safeParse({ path: 'x', message: 'y', contents: '{}' }).success,
    ).toBe(false);
  });
});
