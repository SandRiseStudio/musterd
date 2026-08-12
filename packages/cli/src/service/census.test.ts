import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { censusNotes, inspectCensus, listCensusLabels } from './census.js';
import { AUTOREFRESH_LABEL, HOST_LABEL, SERVICE_LABEL } from './launchd.js';

function plistWithLabel(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
</dict>
</plist>
`;
}

describe('censusNotes (ADR 232 increment 2)', () => {
  it('names a musterd-labeled job that has no service seat — one warn line', () => {
    const notes = censusNotes({
      labels: ['studio.sandrise.musterd-fake'],
      serviceSeats: [],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/studio\.sandrise\.musterd-fake/);
    expect(notes[0]).toMatch(/unattributed/);
  });

  it('is silent when the job has a matching service seat', () => {
    expect(censusNotes({ labels: [AUTOREFRESH_LABEL], serviceSeats: ['autorefresh'] })).toEqual([]);
  });

  it('ignores the daemon plist — it is the runtime, not a ledger seat', () => {
    expect(censusNotes({ labels: [SERVICE_LABEL], serviceSeats: [] })).toEqual([]);
  });

  it('ignores a LaunchAgent that is not musterd-labeled', () => {
    expect(censusNotes({ labels: ['com.example.unrelated'], serviceSeats: [] })).toEqual([]);
  });

  it('names a platform service seat whose LaunchAgent is gone', () => {
    const notes = censusNotes({
      labels: [],
      serviceSeats: ['autorefresh'],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/autorefresh/);
    expect(notes[0]).toMatch(/gone/);
  });

  it('does not treat a project-service seat as a missing LaunchAgent', () => {
    expect(censusNotes({ labels: [], serviceSeats: ['deploybot'] })).toEqual([]);
  });

  it('warns only on the fake job when a known seat is attributed', () => {
    const notes = censusNotes({
      labels: [AUTOREFRESH_LABEL, 'studio.sandrise.musterd-fake'],
      serviceSeats: ['autorefresh'],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/musterd-fake/);
  });

  it('does not double-count a host job that has its seat', () => {
    expect(censusNotes({ labels: [HOST_LABEL], serviceSeats: ['host'] })).toEqual([]);
  });
});

describe('listCensusLabels', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the Label from each plist, even when the filename disagrees', () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'hand-authored.plist'), plistWithLabel('studio.sandrise.musterd-fake'));
    writeFileSync(join(dir, `${SERVICE_LABEL}.plist`), plistWithLabel(SERVICE_LABEL));
    expect(listCensusLabels(dir)).toEqual([SERVICE_LABEL, 'studio.sandrise.musterd-fake']);
  });

  it('skips garbage and a missing directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'broken.plist'), 'not a plist');
    expect(listCensusLabels(dir)).toEqual([]);
    expect(listCensusLabels(join(dir, 'no-such'))).toEqual([]);
  });
});

describe('inspectCensus', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('is silent on a non-darwin platform even when jobs exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'fake.plist'), plistWithLabel('studio.sandrise.musterd-fake'));
    expect(
      await inspectCensus({
        agentsDir: dir,
        members: [],
        platform: 'linux',
      }),
    ).toEqual([]);
  });

  it('produces the fake-plist warn against an empty service roster', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'fake.plist'), plistWithLabel('studio.sandrise.musterd-fake'));
    const notes = await inspectCensus({
      agentsDir: dir,
      members: [{ name: 'nick', kind: 'human' }],
      platform: 'darwin',
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/musterd-fake/);
  });

  it('uses fetched members when none are injected', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'fake.plist'), plistWithLabel('studio.sandrise.musterd-fake'));
    const notes = await inspectCensus({
      agentsDir: dir,
      platform: 'darwin',
      fetchMembers: async () => [],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/musterd-fake/);
  });

  it('stays silent when the roster cannot be read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'fake.plist'), plistWithLabel('studio.sandrise.musterd-fake'));
    expect(
      await inspectCensus({
        agentsDir: dir,
        platform: 'darwin',
        fetchMembers: async () => undefined,
      }),
    ).toEqual([]);
  });
});
