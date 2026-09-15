import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  censusNotes,
  inspectCensus,
  listCensusJobs,
  listCensusLabels,
  parsePlistOneShot,
} from './census.js';
import {
  AUTOREFRESH_LABEL,
  GUARDIAN_LABEL,
  HOST_LABEL,
  SERVICE_LABEL,
  STREAMWATCH_LABEL,
} from './launchd.js';

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

/** A dated one-shot: `StartCalendarInterval` with a Month + Day and no `StartInterval`. */
function oneShotPlist(label: string, month: number, day: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>${month}</integer>
    <key>Day</key><integer>${day}</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>7</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

const job = (label: string) => ({ label });
const platform = (name: string) => ({ name, roles: ['platform'] });
const project = (name: string) => ({ name, roles: [] as string[] });

describe('censusNotes (ADR 232 increment 2)', () => {
  it('names a musterd-labeled job that has no service seat — one warn line', () => {
    const notes = censusNotes({ jobs: [job('studio.sandrise.musterd-fake')], seats: [] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/studio\.sandrise\.musterd-fake/);
    expect(notes[0]).toMatch(/unattributed/);
  });

  it('is silent when the job has a matching service seat', () => {
    expect(
      censusNotes({ jobs: [job(AUTOREFRESH_LABEL)], seats: [platform('autorefresh')] }),
    ).toEqual([]);
  });

  it('ignores the daemon plist — it is the runtime, not a ledger seat', () => {
    expect(censusNotes({ jobs: [job(SERVICE_LABEL)], seats: [] })).toEqual([]);
  });

  it('ignores a LaunchAgent that is not musterd-labeled', () => {
    expect(censusNotes({ jobs: [job('com.example.unrelated')], seats: [] })).toEqual([]);
  });

  it('names a platform service seat whose LaunchAgent is gone', () => {
    const notes = censusNotes({ jobs: [], seats: [platform('autorefresh')] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/autorefresh/);
    expect(notes[0]).toMatch(/gone/);
  });

  it('does not treat a project-service seat as a missing LaunchAgent', () => {
    expect(censusNotes({ jobs: [], seats: [project('deploybot')] })).toEqual([]);
  });

  it('warns only on the fake job when a known seat is attributed', () => {
    const notes = censusNotes({
      jobs: [job(AUTOREFRESH_LABEL), job('studio.sandrise.musterd-fake')],
      seats: [platform('autorefresh')],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/musterd-fake/);
  });

  it('does not double-count a host job that has its seat', () => {
    expect(censusNotes({ jobs: [job(HOST_LABEL)], seats: [platform('host')] })).toEqual([]);
  });

  /**
   * Lane 01M1Q9D90X — the job-gone set is DERIVED from the roster, never a literal.
   *
   * Measured 2026-09-04: `guardian` and `streamwatch` were `kind: service, role: platform` seats with
   * live LaunchAgents, and both were outside the frozen `PLATFORM_SERVICE_LABELS` — so either could
   * lose its job in total silence, and guardian is the daemon watchdog. The falsifier the lane asks
   * for: a platform seat the census has never heard of, with no job, must be reported WITHOUT anyone
   * editing census.ts. That is what these three pin.
   */
  it('names guardian and streamwatch when their jobs are gone — the two the literal could not see', () => {
    const notes = censusNotes({
      jobs: [job(AUTOREFRESH_LABEL)],
      seats: [platform('autorefresh'), platform('guardian'), platform('streamwatch')],
    });
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).toMatch(/"guardian" has no LaunchAgent/);
    expect(notes.join('\n')).toMatch(/"streamwatch" has no LaunchAgent/);
  });

  it('is silent for guardian and streamwatch when their jobs are present', () => {
    expect(
      censusNotes({
        jobs: [job(GUARDIAN_LABEL), job(STREAMWATCH_LABEL)],
        seats: [platform('guardian'), platform('streamwatch')],
      }),
    ).toEqual([]);
  });

  it('FALSIFIER: a platform seat census.ts has never heard of is reported when its job is gone', () => {
    // No constant for this label exists anywhere in the CLI. If this passes, the set is derived.
    const notes = censusNotes({ jobs: [], seats: [platform('never-seen-before')] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"never-seen-before" has no LaunchAgent/);
  });

  it('a service seat that is NOT platform is still not a missing LaunchAgent, whatever its name', () => {
    expect(censusNotes({ jobs: [], seats: [{ name: 'host', roles: ['steward'] }] })).toEqual([]);
  });

  /**
   * A dated one-shot (`StartCalendarInterval` with Month + Day, no `StartInterval`) has no standing
   * presence to attribute — `adr260-rerun` fires once on 2026-09-11 and never again. Warning
   * "unattributed actor" about it forever trains the reader to clear the census on sight, which is
   * the ADR 230 failure. It is named for what it is, and named again when it has already fired.
   */
  it('names a dated one-shot as a task, not an unattributed actor', () => {
    const notes = censusNotes({
      jobs: [{ label: 'studio.sandrise.musterd-adr260-rerun', oneShot: { month: 9, day: 11 } }],
      seats: [],
      now: Date.UTC(2026, 8, 4),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/one-shot/);
    expect(notes[0]).toMatch(/09-11/);
    expect(notes[0]).not.toMatch(/unattributed/);
  });

  it('says an expired one-shot is still installed, so it gets removed rather than ignored', () => {
    const notes = censusNotes({
      jobs: [{ label: 'studio.sandrise.musterd-adr260-rerun', oneShot: { month: 9, day: 11 } }],
      seats: [],
      now: Date.UTC(2026, 8, 20),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/already fired/);
    expect(notes[0]).toMatch(/remove/);
  });
});

describe('parsePlistOneShot', () => {
  it('reads Month + Day from a StartCalendarInterval with no StartInterval', () => {
    expect(parsePlistOneShot(oneShotPlist('x', 9, 11))).toEqual({ month: 9, day: 11 });
  });

  it('is null for an interval job, a job with RunAtLoad only, and a calendar job with no Day', () => {
    expect(parsePlistOneShot(plistWithLabel('x'))).toBeNull();
    expect(
      parsePlistOneShot(
        '<plist><dict><key>StartInterval</key><integer>300</integer></dict></plist>',
      ),
    ).toBeNull();
    // A daily job (Hour + Minute, no Day) recurs — it is a service, not a one-shot.
    expect(
      parsePlistOneShot(
        '<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer></dict></dict></plist>',
      ),
    ).toBeNull();
  });
});

describe('listCensusJobs', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('carries the one-shot schedule alongside the label', () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    writeFileSync(join(dir, 'a.plist'), oneShotPlist('studio.sandrise.musterd-once', 9, 11));
    writeFileSync(join(dir, 'b.plist'), plistWithLabel(AUTOREFRESH_LABEL));
    expect(listCensusJobs(dir)).toEqual([
      { label: AUTOREFRESH_LABEL },
      { label: 'studio.sandrise.musterd-once', oneShot: { month: 9, day: 11 } },
    ]);
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
      members: [{ name: 'nick', kind: 'human', roles: [] }],
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

  it('derives the platform set from the roster: a platform service seat with no job is named', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    // guardian's job is present; streamwatch's is gone; deploybot is a project service (no roles).
    writeFileSync(join(dir, 'g.plist'), plistWithLabel(GUARDIAN_LABEL));
    const notes = await inspectCensus({
      agentsDir: dir,
      platform: 'darwin',
      members: [
        { name: 'nick', kind: 'human', roles: [] },
        { name: 'guardian', kind: 'service', roles: ['platform'] },
        { name: 'streamwatch', kind: 'service', roles: ['platform'] },
        { name: 'deploybot', kind: 'service', roles: [] },
      ],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"streamwatch" has no LaunchAgent/);
  });

  it('falls back to the display role when an older daemon omits `roles`', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
    const notes = await inspectCensus({
      agentsDir: dir,
      platform: 'darwin',
      members: [{ name: 'guardian', kind: 'service', role: 'platform' }],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"guardian" has no LaunchAgent/);
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
