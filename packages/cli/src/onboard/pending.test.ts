import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, PENDING_DIR, type PendingSession } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_MARKER_TTL_MS, listPendingForWorkspace, writePending } from './pending.js';

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
    ts: Date.now(),
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

/**
 * Nothing had ever reaped these files. The adapter writes one at boot and only a claim that ADOPTS
 * that code removes it, so a session that exits unclaimed leaves its marker forever — measured
 * 2026-09-04 at 189 markers across 15 dirs on one machine, 176 older than a week. They are not
 * inert: two matching markers make `musterd claim` refuse with "several unclaimed sessions are
 * waiting here", which is the documented repair for an expired session lease.
 */
describe('pending-marker expiry (the read is the reaper)', () => {
  let root: string;
  let ws: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-pending-ttl-'));
    ws = join(root, 'workspace');
    mkdirSync(join(ws, BINDING_DIR), { recursive: true });
    writeFileSync(join(ws, BINDING_DIR, BINDING_FILE), '{}', 'utf8');
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
    ts: Date.now(),
    ...over,
  });

  const markerFile = (code: string): string => join(ws, BINDING_DIR, PENDING_DIR, `${code}.json`);

  it('drops an expired marker from the listing AND deletes it from disk', () => {
    const stale = Date.now() - PENDING_MARKER_TTL_MS - 1;
    writePending(ws, marker({ code: 'OLD1', ts: stale }));
    expect(existsSync(markerFile('OLD1'))).toBe(true);

    expect(listPendingForWorkspace(ws, 'dawn', 'ws')).toEqual([]);
    expect(existsSync(markerFile('OLD1'))).toBe(false);
  });

  it('keeps a marker that is old but still inside the window — `ts` is a boot stamp, not a heartbeat', () => {
    const nearly = Date.now() - PENDING_MARKER_TTL_MS + 60_000;
    writePending(ws, marker({ code: 'YNG1', ts: nearly }));

    expect(listPendingForWorkspace(ws, 'dawn', 'ws').map((p) => p.code)).toEqual(['YNG1']);
    expect(existsSync(markerFile('YNG1'))).toBe(true);
  });

  it('reaps an expired marker belonging to ANOTHER team/workspace — expiry is a property of the marker, not of the query', () => {
    const stale = Date.now() - PENDING_MARKER_TTL_MS - 1;
    writePending(ws, marker({ code: 'FRGN', team: 'other', workspace: 'elsewhere', ts: stale }));

    // The caller is asking about dawn/ws and is shown nothing either way — but the file must go,
    // or the dir grows for every seat except the one that happened to read it.
    expect(listPendingForWorkspace(ws, 'dawn', 'ws')).toEqual([]);
    expect(existsSync(markerFile('FRGN'))).toBe(false);
  });

  it('leaves a LIVE foreign-workspace marker alone (the 2026-07-01 scoping fix still holds)', () => {
    writePending(ws, marker({ code: 'LIVE', workspace: 'elsewhere' }));

    expect(listPendingForWorkspace(ws, 'dawn', 'ws')).toEqual([]);
    expect(existsSync(markerFile('LIVE'))).toBe(true);
  });

  it('the two stale markers that blocked a real claim are gone, and the live one is offered alone', () => {
    // The measured case: agents-dolly on a detached HEAD, whose bare label matched a cursor marker
    // from Jul 31 and a codex marker from Aug 18. Two matches ⇒ `claim` refused and demanded --for.
    const old = Date.now() - PENDING_MARKER_TTL_MS - 1;
    writePending(ws, marker({ code: 'B99V', surface: 'cursor', ts: old }));
    writePending(ws, marker({ code: '74FF', surface: 'codex', ts: old }));
    writePending(ws, marker({ code: 'NOWX', surface: 'claude-code' }));

    const live = listPendingForWorkspace(ws, 'dawn', 'ws');
    expect(live.map((p) => p.code)).toEqual(['NOWX']);
    // One match ⇒ no `--for` demanded: the claim proceeds, which is the whole point.
    expect(live).toHaveLength(1);
    expect(existsSync(markerFile('B99V'))).toBe(false);
    expect(existsSync(markerFile('74FF'))).toBe(false);
  });

  it('takes an injected clock, so the window is testable without touching the filesystem clock', () => {
    writePending(ws, marker({ code: 'CLK1' }));
    const wayLater = Date.now() + PENDING_MARKER_TTL_MS + 1;

    expect(listPendingForWorkspace(ws, 'dawn', 'ws', wayLater)).toEqual([]);
    expect(existsSync(markerFile('CLK1'))).toBe(false);
  });
});
