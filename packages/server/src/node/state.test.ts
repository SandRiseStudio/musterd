import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeStatePath, readNodeState, saveNodeEnrollment } from './state.js';

/**
 * `~/.musterd/node.json` (ADR 328 §2) — the machine's node credentials, one entry per enrolled
 * team. Machine-local, mode 0600, never a workspace and never the repo.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-node-state-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
});

afterEach(() => {
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('node.json', () => {
  it('round-trips an enrollment and writes it 0600', () => {
    saveNodeEnrollment({
      team: 'revive',
      hub_url: 'https://hub.example:7777',
      node_id: '01M',
      credential: 'msnode_aaa',
      enrolled_at: 1,
    });

    expect(readNodeState().nodes['revive']?.credential).toBe('msnode_aaa');
    expect(readNodeState().nodes['revive']?.hub_url).toBe('https://hub.example:7777');
    // A credential at 0644 is a credential every process on the machine can read.
    expect(statSync(nodeStatePath()).mode & 0o777).toBe(0o600);
  });

  it('keeps one entry per team — a daemon hosting two teams holds two identities', () => {
    saveNodeEnrollment({
      team: 'one',
      hub_url: 'https://a.example',
      node_id: '01A',
      credential: 'msnode_aaa',
      enrolled_at: 1,
    });
    saveNodeEnrollment({
      team: 'two',
      hub_url: 'https://b.example',
      node_id: '01B',
      credential: 'msnode_bbb',
      enrolled_at: 2,
    });

    const state = readNodeState();
    expect(Object.keys(state.nodes).sort()).toEqual(['one', 'two']);
    expect(state.nodes['one']?.node_id).toBe('01A');
    expect(state.nodes['two']?.node_id).toBe('01B');
  });

  it('re-enrolling a team replaces that entry and leaves the others alone', () => {
    saveNodeEnrollment({
      team: 'one',
      hub_url: 'https://a.example',
      node_id: '01A',
      credential: 'msnode_old',
      enrolled_at: 1,
    });
    saveNodeEnrollment({
      team: 'two',
      hub_url: 'https://b.example',
      node_id: '01B',
      credential: 'msnode_bbb',
      enrolled_at: 2,
    });
    saveNodeEnrollment({
      team: 'one',
      hub_url: 'https://a.example',
      node_id: '01A',
      credential: 'msnode_new',
      enrolled_at: 3,
    });

    const state = readNodeState();
    expect(state.nodes['one']?.credential).toBe('msnode_new');
    expect(state.nodes['two']?.credential).toBe('msnode_bbb');
  });

  it('re-saving over an existing file keeps 0600 rather than inheriting the old mode', () => {
    // writeFileSync's `mode` applies only at CREATE. A file that already exists keeps whatever
    // permissions it had, so a node.json created 0644 by an older build (or a careless hand edit)
    // would silently stay world-readable through every later write.
    writeFileSync(nodeStatePath(), '{"nodes":{}}\n', { mode: 0o644 });
    saveNodeEnrollment({
      team: 'revive',
      hub_url: 'https://hub.example',
      node_id: '01M',
      credential: 'msnode_aaa',
      enrolled_at: 1,
    });
    expect(statSync(nodeStatePath()).mode & 0o777).toBe(0o600);
  });

  it('reads an absent or malformed file as "no enrollments", never as an error', () => {
    expect(readNodeState().nodes).toEqual({});
    writeFileSync(nodeStatePath(), 'not json at all');
    expect(readNodeState().nodes).toEqual({});
    writeFileSync(nodeStatePath(), '{"nodes":{"revive":{"credential":42}}}');
    expect(readNodeState().nodes).toEqual({});
  });
});
