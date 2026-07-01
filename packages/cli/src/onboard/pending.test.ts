import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, PENDING_DIR, type PendingSession } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPendingForWorkspace, writePending } from './pending.js';

/**
 * Marker-dir resolution + workspace-scoped listing (the 2026-07-01 dogfood bug): an unbound folder
 * must not resolve its `.musterd` up to an ancestor that has a `.musterd` *without* a binding (the
 * global `~/.musterd` config dir is exactly that shape), and the list must be scoped to one workspace.
 */
describe('pending-marker dir resolution', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-pending-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const marker = (over: Partial<PendingSession> = {}): PendingSession => ({
    code: 'AB12',
    team: 'dawn',
    workspace: 'ws',
    surface: 'claude-code',
    connId: 'c1',
    ts: 1,
    ...over,
  });

  it('does NOT leak markers to an ancestor `.musterd` that has no binding (global-config shape)', () => {
    // Ancestor `.musterd` with a config.json but NO binding.json — the global config dir's shape.
    mkdirSync(join(root, BINDING_DIR), { recursive: true });
    writeFileSync(join(root, BINDING_DIR, 'config.json'), '{}', 'utf8');
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });

    const path = writePending(ws, marker());
    // The marker lands in the workspace's own `.musterd`, not the ancestor's.
    expect(path).toBe(join(ws, BINDING_DIR, PENDING_DIR, 'AB12.json'));
    expect(existsSync(join(root, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
  });

  it('attaches markers to a bound ancestor (walks up to the `.musterd` that has a binding)', () => {
    // Ancestor `.musterd` WITH a binding.json — a real bound workspace root.
    mkdirSync(join(root, BINDING_DIR), { recursive: true });
    writeFileSync(join(root, BINDING_DIR, BINDING_FILE), '{}', 'utf8');
    const sub = join(root, 'src', 'nested');
    mkdirSync(sub, { recursive: true });

    const path = writePending(sub, marker());
    expect(path).toBe(join(root, BINDING_DIR, PENDING_DIR, 'AB12.json'));
  });

  it('listPendingForWorkspace filters by team and (optionally) workspace', () => {
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });
    writePending(ws, marker({ code: 'MINE', workspace: 'ws' }));
    writePending(ws, marker({ code: 'THEIRS', workspace: 'other-ws' }));
    writePending(ws, marker({ code: 'OTHERTEAM', team: 'dusk', workspace: 'ws' }));

    // Team only → both dawn markers (workspace-blind).
    expect(
      listPendingForWorkspace(ws, 'dawn')
        .map((p) => p.code)
        .sort(),
    ).toEqual(['MINE', 'THEIRS']);
    // Team + workspace → only this workspace's marker.
    expect(listPendingForWorkspace(ws, 'dawn', 'ws').map((p) => p.code)).toEqual(['MINE']);
    // Foreign team never matches.
    expect(listPendingForWorkspace(ws, 'dusk', 'ws').map((p) => p.code)).toEqual(['OTHERTEAM']);
  });
});
