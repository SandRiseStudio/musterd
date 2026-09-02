import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalServer, loadHostRegistry, removeHostEntry, upsertHostEntry } from './registry.js';

describe('host registry (ADR 131 inc 3 — the machine-local seat→workspace store)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-host-registry-'));
    path = join(dir, 'nested', 'host-registry.json'); // nested: exercises mkdir -p on save
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = {
    server: 'http://127.0.0.1:4849',
    team: 'dawn',
    seat: 'scout',
    workspace: '/tmp/ws-scout',
    harness: 'claude-code',
    host: 'mac.lan',
  };

  it('missing file reads as empty (rebuildable, never a hard failure)', () => {
    expect(loadHostRegistry(path)).toEqual({ entries: [] });
  });

  it('malformed file reads as empty', () => {
    writeFileSync(join(dir, 'bad.json'), '{"entries": "nope"');
    expect(loadHostRegistry(join(dir, 'bad.json'))).toEqual({ entries: [] });
  });

  it('upsert → load round-trips and stamps updated_at', () => {
    upsertHostEntry(entry, path);
    const loaded = loadHostRegistry(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject(entry);
    expect(loaded.entries[0]!.updated_at).toBeGreaterThan(0);
    // File is plain JSON a human can read/fix.
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1);
  });

  /**
   * Lane 01M1J2V4EJ (2026-09-02): `residency on` copied the binding's server verbatim, and one
   * workspace spelled the daemon `localhost` where the others said `127.0.0.1`. The registry is a
   * map keyed on the DAEMON, not on a string a human typed — normalise on write so two spellings of
   * one socket can never be two entries, two poll groups, or two identities for `off`.
   */
  it('normalises the server on write: localhost, ::1 and a trailing slash all read as 127.0.0.1', () => {
    for (const spelled of [
      'http://localhost:4849',
      'http://LOCALHOST:4849/',
      'http://[::1]:4849',
      'http://127.0.0.1:4849/',
    ]) {
      expect(canonicalServer(spelled)).toBe('http://127.0.0.1:4849');
    }
    // A remote daemon keeps its host; only case and the trailing slash are folded.
    expect(canonicalServer('HTTPS://Hub.Example.com:4849/')).toBe('https://hub.example.com:4849');
    // Not a URL at all: returned as-is (the loop still groups on whatever string this is).
    expect(canonicalServer('not a url')).toBe('not a url');
    upsertHostEntry({ ...entry, server: 'http://localhost:4849' }, path);
    expect(loadHostRegistry(path).entries[0]!.server).toBe('http://127.0.0.1:4849');
  });

  it('two spellings of one daemon are ONE entry on upsert and ONE identity on remove', () => {
    upsertHostEntry({ ...entry, server: 'http://127.0.0.1:4849' }, path);
    upsertHostEntry(
      { ...entry, server: 'http://localhost:4849', workspace: '/tmp/ws-scout-2' },
      path,
    );
    const loaded = loadHostRegistry(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.workspace).toBe('/tmp/ws-scout-2');
    expect(
      removeHostEntry({ server: 'http://localhost:4849/', team: 'dawn', seat: 'scout' }, path),
    ).toBe(true);
    expect(loadHostRegistry(path).entries).toHaveLength(0);
  });

  it('upsert is keyed (server, team, seat): re-enroll moves the workspace, last-write-wins', () => {
    upsertHostEntry(entry, path);
    upsertHostEntry({ ...entry, workspace: '/tmp/ws-scout-2', host: 'mac.local' }, path);
    const loaded = loadHostRegistry(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.workspace).toBe('/tmp/ws-scout-2');
    expect(loaded.entries[0]!.host).toBe('mac.local');
  });

  it('different seats coexist; remove takes exactly one', () => {
    upsertHostEntry(entry, path);
    upsertHostEntry({ ...entry, seat: 'kai', workspace: '/tmp/ws-kai' }, path);
    expect(removeHostEntry({ server: entry.server, team: 'dawn', seat: 'scout' }, path)).toBe(true);
    const loaded = loadHostRegistry(path);
    expect(loaded.entries.map((e) => e.seat)).toEqual(['kai']);
  });

  it('remove without a server (off run outside the workspace) still matches by team+seat', () => {
    upsertHostEntry(entry, path);
    expect(removeHostEntry({ team: 'dawn', seat: 'scout' }, path)).toBe(true);
    expect(loadHostRegistry(path).entries).toHaveLength(0);
  });

  it('remove of an absent seat reports false and rewrites nothing', () => {
    upsertHostEntry(entry, path);
    expect(removeHostEntry({ team: 'dawn', seat: 'ghost' }, path)).toBe(false);
    expect(loadHostRegistry(path).entries).toHaveLength(1);
  });
});
