import type { Binding } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { agentKeyNotes } from '../onboard/doctor.js';
import { recoverAgentKey } from './team.js';

/**
 * `musterd team agent-key` — the recovery affordance for a lost team agent key.
 *
 * Why recovery and not rotation is the default: on team `revive` (2026-08-14) the global config's
 * `agentKeys` map was empty, but ELEVEN live seat worktrees each carried the same `mskey_` in their
 * gitignored `binding.json`. The key was never lost from the machine, only from the one file that
 * records it. Rotating in that state mints a key none of those eleven bindings hold — it would take
 * the whole team offline to fix a bookkeeping gap. So the default reads what is already here, and
 * rotation is a separate, explicitly-asked-for act.
 */

const bindingWith = (team: string, key?: string): Binding =>
  ({
    server: 'http://127.0.0.1:4849',
    team,
    surface: 'claude-code',
    claim: { mode: 'seat', name: 'x' },
    ...(key ? { agent_key: key } : {}),
  }) as Binding;

describe('recoverAgentKey — read the key off the seat bindings this machine already holds', () => {
  it('recovers the key when every seat binding for the team agrees', () => {
    const res = recoverAgentKey(['/w/a', '/w/b', '/w/c'], 'revive', () =>
      bindingWith('revive', 'mskey_same'),
    );
    expect(res.key).toBe('mskey_same');
    expect(res.sources).toEqual(['/w/a', '/w/b', '/w/c']);
    expect(res.conflicts).toEqual([]);
  });

  it('ignores folders bound to a DIFFERENT team — a second team on this machine is not evidence', () => {
    const res = recoverAgentKey(['/w/a', '/w/other'], 'revive', (d) =>
      d === '/w/other' ? bindingWith('dawn', 'mskey_dawn') : bindingWith('revive', 'mskey_revive'),
    );
    expect(res.key).toBe('mskey_revive');
    expect(res.sources).toEqual(['/w/a']);
  });

  it('ignores a binding carrying a HUMAN credential — only mskey_ is the team key', () => {
    // The admin's own folder authenticates with their mscr_ credential (ADR 075). Recording that as
    // the team key is exactly the dead-binding corruption doctor.ts:334 exists to catch.
    const res = recoverAgentKey(['/w/nick', '/w/agent'], 'revive', (d) =>
      bindingWith('revive', d === '/w/nick' ? 'mscr_human' : 'mskey_team'),
    );
    expect(res.key).toBe('mskey_team');
    expect(res.sources).toEqual(['/w/agent']);
  });

  it('refuses and reports every candidate when the bindings DISAGREE', () => {
    // Two keys in flight means a rotation landed partway. Picking one silently would re-break the
    // other half, so this abstains and hands the operator the evidence to choose with --key.
    const res = recoverAgentKey(['/w/a', '/w/b', '/w/c'], 'revive', (d) =>
      bindingWith('revive', d === '/w/b' ? 'mskey_new' : 'mskey_old'),
    );
    expect(res.key).toBeNull();
    expect(res.conflicts).toEqual([
      { key: 'mskey_old', dirs: ['/w/a', '/w/c'] },
      { key: 'mskey_new', dirs: ['/w/b'] },
    ]);
  });

  it('returns nothing to recover when no binding carries a team key', () => {
    const res = recoverAgentKey(['/w/a'], 'revive', () => bindingWith('revive'));
    expect(res.key).toBeNull();
    expect(res.sources).toEqual([]);
    expect(res.conflicts).toEqual([]);
  });

  it('skips folders whose binding is gone — a deleted worktree must not throw', () => {
    const res = recoverAgentKey(['/w/gone', '/w/a'], 'revive', (d) =>
      d === '/w/gone' ? null : bindingWith('revive', 'mskey_team'),
    );
    expect(res.key).toBe('mskey_team');
    expect(res.sources).toEqual(['/w/a']);
  });
});

describe('agentKeyNotes — `init --check` says so BEFORE a command fails on it', () => {
  const cfg = (agentKeys: Record<string, string>, bindings: string[]) => ({
    agentKeys,
    bindings: Object.fromEntries(bindings.map((d) => [d, { team: 'revive', seat: 'x' }])),
  });

  it('warns when the record is missing but the key is recoverable here', () => {
    const notes = agentKeyNotes(cfg({}, ['/w/a', '/w/b']) as never, 'revive', () =>
      bindingWith('revive', 'mskey_team'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('musterd team agent-key --team revive');
    expect(notes[0]).toContain('2 seat binding(s)');
  });

  it('stays silent when the key IS recorded', () => {
    expect(
      agentKeyNotes(cfg({ revive: 'mskey_team' }, ['/w/a']) as never, 'revive', () =>
        bindingWith('revive', 'mskey_team'),
      ),
    ).toEqual([]);
  });

  it('stays silent when nothing is recoverable — never nudge toward a blind --rotate', () => {
    // Pointing at rotation here would suggest a team-wide outage as the repair for a machine that
    // simply never held the key. Say nothing instead.
    expect(
      agentKeyNotes(cfg({}, ['/w/a']) as never, 'revive', () => bindingWith('revive')),
    ).toEqual([]);
  });

  it('stays silent with no team in scope', () => {
    expect(agentKeyNotes(cfg({}, ['/w/a']) as never, undefined, () => null)).toEqual([]);
  });
});
