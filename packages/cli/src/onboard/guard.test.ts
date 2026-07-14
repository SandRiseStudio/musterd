import type { Binding, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { liveBindingClobber } from './guard.js';

/** A folder binding whose seat is `name`. */
const boundTo = (name: string): Binding => ({
  server: 'http://127.0.0.1:4849',
  team: 'dawn',
  surface: 'cli',
  agent_key: 'mskey_x',
  claim: { mode: 'seat', name },
});

/** A roster summary; offline + no presences by default. */
const member = (over: Partial<MemberSummary> & { name: string }): MemberSummary => ({
  id: over.name,
  team: 'dawn',
  kind: 'agent',
  role: '',
  lifecycle: 'forever',
  created_at: 0,
  presence: 'offline',
  presences: [],
  ...over,
});

describe('liveBindingClobber (ADR 066/105)', () => {
  it('does not clobber a plain-offline bound seat (a stale seat is safe to reclaim)', () => {
    const roster = [member({ name: 'Ada', presence: 'offline', activity: 'offline' })];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toBeNull();
  });

  it('clobbers a live bound seat, naming where it is live', () => {
    const roster = [
      member({
        name: 'Ada',
        presence: 'online',
        activity: 'idle',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 1, workspace: 'repo@main' }],
      }),
    ];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toEqual({
      member: 'Ada',
      workspace: 'repo@main',
    });
  });

  it('clobbers a seat held within its reclaim grace even though it reads offline (ADR 105)', () => {
    // A reservation: presence/activity are offline (grace is hidden from display) but reclaimable is set.
    const roster = [
      member({ name: 'Ada', presence: 'offline', activity: 'offline', reclaimable: true }),
    ];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Bob')).toEqual({
      member: 'Ada',
      reclaimable: true,
    });
  });

  it('never clobbers when re-occupying our own seat, even if reclaimable', () => {
    const roster = [member({ name: 'Ada', reclaimable: true })];
    expect(liveBindingClobber(boundTo('Ada'), roster, 'Ada')).toBeNull();
  });

  it('does not clobber when the bound seat is not on the roster', () => {
    expect(liveBindingClobber(boundTo('Ghost'), [member({ name: 'Ada' })], 'Bob')).toBeNull();
  });
});
