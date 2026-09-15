import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MusterdClient } from './client.js';
import { SessionAttestation } from './sessionLiveness.js';

/**
 * Lane 01M2KCG5Z8 — the WIRING half. `shouldReleaseOnVerdict` is unit-tested in
 * sessionLiveness.test.ts; this file exists because the defect could survive a perfect pure
 * function. `attestSession` is the only caller, and if it does not hand the verdict's transcript
 * age down, the new clause is dead code and the seat is still released on every heartbeat.
 *
 * The scenario is the measured one, on seat `izzo` 2026-09-15: the binding names a session whose
 * transcript has been quiet for hours, the harness is driving this adapter from a different session,
 * and nothing rewrote `binding.session` — so the adopted id never changes and no re-adoption guard
 * fires.
 */
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DEAD_SESSION = {
  harness: 'claude-code',
  id: 'sess-that-died',
  transcript_path: '/t/dead.jsonl',
  started_at: 1,
};

function adapterJudging() {
  dir = mkdtempSync(join(tmpdir(), 'musterd-attest-'));
  mkdirSync(join(dir, '.musterd'));
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      agent_key: 'mskey_team',
      claim: { mode: 'seat', name: 'Ada' },
      session: DEAD_SESSION,
    }),
  );
  const client = new MusterdClient({
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'musterd',
    provenance: 'session',
    workspace: 'agents@main',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: dir,
  } as never);
  // The transcript's age is a knob, because the defect needs BOTH phases and my first attempt at
  // this harness only had the second: the ladder refuses to adopt a capture that is already a
  // corpse, so a binding born stale is never judged at all and the test passed for the wrong
  // reason. The real session was adopted while alive at 17:13Z and only crossed the staleness
  // horizon at 20:06Z, three hours later — that is the shape reproduced here.
  let transcriptAgeMs = 0;
  // Injected rather than left to the real world: the ladder adopts nothing for the first
  // ADOPT_SETTLE_MS of PROCESS life, and a test runner's uptime is not something to gamble a
  // regression test on. processStart 0 means settled; the stat is controlled.
  (client as unknown as { session: SessionAttestation }).session = new SessionAttestation({
    bindingDir: dir,
    readSession: () => DEAD_SESSION,
    statMtime: () => Date.now() - transcriptAgeMs,
    ppid: () => 4242,
    processStart: 0,
  });
  // `attestSession` is private and deliberately so; this is the one place that needs it, and going
  // through the 15s heartbeat instead would buy nothing but a slow test.
  const attest = () => (client as unknown as { attestSession: () => boolean }).attestSession();
  // Phase 1: the session is alive and writing, so the adapter adopts it — as it legitimately did.
  expect(attest(), 'a live session must be adopted, not released').toBe(false);
  return {
    client,
    attest,
    /** Phase 2: the harness moved on, nothing rewrote `binding.session`, and the adopted
     *  transcript falls silent past the one-hour horizon. */
    transcriptFallsSilent: () => {
      transcriptAgeMs = 2 * 60 * 60_000;
    },
  };
}

describe('attestSession hands the transcript age down (lane 01M2KCG5Z8)', () => {
  it('keeps the seat when this adapter was driven after its adopted transcript went quiet', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    transcriptFallsSilent();
    // The harness called a tool three minutes ago — far outside the 15s activity window that used
    // to be the only guard, and unambiguously after a transcript silent for two hours. Both cannot
    // be the same session, so the stale rung is evidence about somebody else.
    client.noteActivity(Date.now() - 180_000);
    expect(attest(), 'a transcript we are newer than is not ours — fail open').toBe(false);
    expect(client.releasedByLiveness).toBe(false);
    client.close();
  });

  it('still releases the seat for a genuinely dormant harness', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    transcriptFallsSilent();
    // Nothing has driven this adapter since, so there is no contradiction to fail open on and the
    // ADR 164 crash backstop must still fire.
    expect(attest(), 'no first-hand evidence — the backstop stands').toBe(true);
    expect(client.releasedByLiveness).toBe(true);
    client.close();
  });
});
