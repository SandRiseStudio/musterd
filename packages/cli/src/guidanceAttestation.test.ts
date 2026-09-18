import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GUIDANCE_CONTENT_VERSION, renderContentStamp } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { workspaceGuidanceEpoch } from './guidanceAttestation.js';
import { writeGuidance } from './onboard/guidance.js';
import { claudeCode } from './onboard/harnesses/claudeCode.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-attest-'));
}

describe('workspaceGuidanceEpoch (ADR 417)', () => {
  it('reads the epoch a provisioned workspace is actually running', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(workspaceGuidanceEpoch(dir)).toBe(GUIDANCE_CONTENT_VERSION);
  });

  it('is undefined for a folder with no guidance — attesting nothing beats guessing', () => {
    expect(workspaceGuidanceEpoch(tmp())).toBeUndefined();
  });

  it('sees a stamp change WITHOUT a process restart — a mid-session refresh is the point', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(workspaceGuidanceEpoch(dir)).toBe(GUIDANCE_CONTENT_VERSION);

    // Rewrite one installed file at an older stamp, as a stale repair would leave it.
    const abs = join(dir, res.files[0]);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# skill\n\nbody\n${renderContentStamp(3, 'b'.repeat(16))}\n`, 'utf8');

    // No memoisation: the SAME process must now report the lower epoch. `cliBuild()` may cache
    // because a dist stamp cannot change under a running process; guidance files demonstrably can.
    expect(workspaceGuidanceEpoch(dir)).toBe(3);
  });
});
