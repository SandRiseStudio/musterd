import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, WAKE_LEASE_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWakeLeaseFile } from './wakeLeaseFile.js';

/**
 * The wake-lease FILE channel (lane 01M1HM8EEK, ADR 354). Codex launches MCP stdio servers with a
 * sanitized environment — measured 2026-09-02 on codex-cli 0.150.1: twelve variables, none of them
 * `MUSTERD_*` — so the env channel ADR 241 relies on never reaches the adapter on that harness. The
 * actuator writes this file beside binding.json at spawn; the adapter reads it ONLY when the env is
 * silent, and honours it ONLY when the file names the adapter's own parent process. That last
 * condition is what keeps it an attestation rather than a default (ADR 236): a human session opened
 * in the same workspace during the wake window has a different parent, and reads nothing.
 */

let dir: string;
const NOW = 1_800_000_000_000;

const write = (body: unknown) => {
  mkdirSync(join(dir, BINDING_DIR), { recursive: true });
  writeFileSync(
    join(dir, BINDING_DIR, WAKE_LEASE_FILE),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
};

const valid = {
  lease_id: '01M1HKKABRN1N967MXZY1EAG19',
  provenance: 'wake',
  harness: 'codex',
  spawner_pid: 4242,
  started_at: NOW - 5_000,
  expires_at: NOW + 1_800_000,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-wake-lease-file-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readWakeLeaseFile — the actuator-written lease, honoured only by the process it spawned', () => {
  it('returns the lease when the file names this process’s parent and is unexpired', () => {
    write(valid);
    const r = readWakeLeaseFile(dir, { now: NOW, ppid: 4242 });
    expect(r).toEqual({ lease_id: valid.lease_id, harness: 'codex' });
  });

  it('is undefined when there is no file — the common case, and it must cost nothing', () => {
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 4242 })).toBeUndefined();
  });

  it('refuses a file whose spawner is NOT this process’s parent — a human session in the same workspace', () => {
    // The whole reason the pid is in the file. Without this, any session opened in the workspace
    // during the wake window would attest a lease it knows nothing about — ADR 236's forbidden
    // assertion, made from a file instead of an env default.
    write(valid);
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 9999 })).toBeUndefined();
  });

  it('refuses an expired file — a wake that ended leaves no lease for the next occupant', () => {
    write({ ...valid, expires_at: NOW - 1 });
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 4242 })).toBeUndefined();
  });

  it('refuses malformed JSON and a wrong shape, quietly — a bad file is a page that renders', () => {
    write('{not json');
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 4242 })).toBeUndefined();
    write({ ...valid, provenance: 'session' });
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 4242 })).toBeUndefined();
    write({ ...valid, lease_id: '' });
    expect(readWakeLeaseFile(dir, { now: NOW, ppid: 4242 })).toBeUndefined();
  });
});
