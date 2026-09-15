import { SURFACES } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  isProbeCapableSurface,
  PROBE_CAPABLE_SURFACES,
  shouldWarnUnobservedModel,
} from './modelProbe.js';

describe('probe-capable surfaces (ADR 101/158 follow-up)', () => {
  it('names only surfaces that exist — the list cannot drift off the Surface vocabulary', () => {
    for (const s of PROBE_CAPABLE_SURFACES) expect(SURFACES).toContain(s);
  });

  it('is false for the surfaces with no probe to miss, and for junk', () => {
    for (const s of ['cli', 'web', 'ios', 'slack', 'other', 'musterd']) {
      expect(isProbeCapableSurface(s)).toBe(false);
    }
    expect(isProbeCapableSurface(undefined)).toBe(false);
    expect(isProbeCapableSurface(null)).toBe(false);
    expect(isProbeCapableSurface('')).toBe(false);
  });
});

describe('shouldWarnUnobservedModel — a declaration where an observation was reachable', () => {
  it('warns on every probe-capable surface that resolved a declared tier', () => {
    for (const s of PROBE_CAPABLE_SURFACES) {
      expect(shouldWarnUnobservedModel(s, 'binding')).toBe(true);
      expect(shouldWarnUnobservedModel(s, 'environment')).toBe(true);
    }
  });

  it('stays silent when the tier is already observed — that is the goal state', () => {
    for (const s of PROBE_CAPABLE_SURFACES) {
      expect(shouldWarnUnobservedModel(s, 'observed')).toBe(false);
    }
  });

  it('stays silent on unknown: nothing was declared, so there is no snapshot to distrust', () => {
    expect(shouldWarnUnobservedModel('claude-code', 'unknown')).toBe(false);
  });

  it('stays silent on a surface with no probe — a declaration is its honest best', () => {
    expect(shouldWarnUnobservedModel('cli', 'binding')).toBe(false);
    expect(shouldWarnUnobservedModel('slack', 'environment')).toBe(false);
    expect(shouldWarnUnobservedModel(undefined, 'binding')).toBe(false);
  });
});
