import { describe, expect, it } from 'vitest';
import type { HostRegistryEntry } from '../host/registry.js';
import { registryDrift } from './residency.js';

/**
 * The drift lines are the remediation, so their wording is the contract (ADR 131 §1). Both faults
 * distinguished here were hit for real on the dogfood machine within one day of each other, and in
 * both cases the operator's next action came entirely from this text.
 */
const entry = (over: Partial<HostRegistryEntry> = {}): HostRegistryEntry => ({
  server: 'http://s1',
  team: 'revive',
  seat: 'izzo',
  workspace: '/ws/izzo',
  harness: 'claude-code',
  host: 'mac.lan',
  updated_at: 1,
  ...over,
});

const enrolled = [{ seat: 'izzo', host: 'mac.lan' }];

describe('registryDrift — the enrollment↔registry cross-check', () => {
  it('says nothing when the workspace holds a binding', () => {
    expect(registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => true)).toEqual([]);
  });

  it('every remediation carries --as: enrollment is admin-gated, and these are read inside a seat', () => {
    // The bug this pins: the hint used to print bare `musterd residency on`, which is refused with
    // `this operation requires an admin seat (is_admin)` when run where the hint tells you to run
    // it — inside the seat's own workspace, authenticating as that agent seat.
    const missing = registryDrift(enrolled, [], 'revive', 'mac.lan', () => false);
    const noBinding = registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => false);
    for (const line of [...missing, ...noBinding]) {
      expect(line).toContain('musterd residency on --as <admin>');
    }
    expect(missing).toHaveLength(1);
    expect(noBinding).toHaveLength(1);
  });

  it('a vanished workspace and an unprovisioned one are different sentences', () => {
    // Vanished: nothing at the path at all — an abandoned worktree the registry outlived.
    const vanished = registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => false);
    expect(vanished[0]).toContain('/ws/izzo no longer exists');
    expect(vanished[0]).toContain("the seat's real workspace");

    // Unprovisioned: the directory is there, the binding is not.
    const bare = registryDrift(
      enrolled,
      [entry()],
      'revive',
      'mac.lan',
      (p) => !p.includes('.musterd'),
    );
    expect(bare[0]).toContain('/ws/izzo has no binding');
    expect(bare[0]).toContain('that workspace');
  });

  it('ignores enrollments on host labels this machine has never answered to', () => {
    const elsewhere = [{ seat: 'izzo', host: 'other.lan' }];
    expect(registryDrift(elsewhere, [], 'revive', 'mac.lan', () => false)).toEqual([]);
  });

  it('scopes to the team — another team’s entry is not this team’s registry', () => {
    const otherTeam = [entry({ team: 'dawn' })];
    const lines = registryDrift(enrolled, otherTeam, 'revive', 'mac.lan', () => true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('missing from this machine');
  });
});
