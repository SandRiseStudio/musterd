import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { renderBanner, renderMessageRow, renderStatusTable } from './rows.js';

// picocolors auto-disables color when stdout is not a TTY (vitest), so output is plain & deterministic.

const kindOf = (name: string) => (name === 'nick' ? 'human' : 'agent') as 'human' | 'agent';

function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'm1',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'team' },
    act: 'status_update',
    body: 'scaffolded auth',
    ts: Date.UTC(2026, 5, 9, 14, 30),
    ...partial,
  } as Envelope;
}

describe('renderMessageRow', () => {
  it('renders a team status_update', () => {
    const out = renderMessageRow(env({}), kindOf);
    expect(out).toContain('Ada');
    expect(out).toContain('[status_update]');
    expect(out).toContain('→ @team');
    expect(out).toContain('scaffolded auth');
  });

  it('marks unread rows with a leading bar', () => {
    const out = renderMessageRow(env({ act: 'request_help', body: 'help', to: { kind: 'member', name: 'nick' } }), kindOf, { unread: true });
    expect(out.startsWith('▌')).toBe(true);
    expect(out).toContain('[request_help]');
    expect(out).toContain('→ nick');
  });

  it('renders a header-only row when body is empty', () => {
    const out = renderMessageRow(env({ act: 'wait', body: '' }), kindOf);
    expect(out).toContain('[wait]');
    expect(out.split('\n')).toHaveLength(1);
  });
});

describe('renderStatusTable', () => {
  it('renders the dawn roster with columns', () => {
    const members: MemberSummary[] = [
      { id: '1', team: 'dawn', name: 'nick', kind: 'human', role: 'lead', lifecycle: 'forever', created_at: 0, presence: 'online', presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }] },
      { id: '2', team: 'dawn', name: 'Ada', kind: 'agent', role: 'backend', lifecycle: 'session', created_at: 0, presence: 'online', presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }] },
      { id: '3', team: 'dawn', name: 'Lin', kind: 'agent', role: 'frontend', lifecycle: 'session', created_at: 0, presence: 'offline', presences: [] },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain('MEMBER');
    expect(out).toContain('PRESENCE');
    expect(out).toContain('nick');
    expect(out).toContain('online via cli');
    expect(out).toContain('online via claude-code');
    expect(out).toContain('offline');
  });
});

describe('renderBanner', () => {
  it('includes the tagline', () => {
    expect(renderBanner()).toContain('persistent teams');
  });
});
