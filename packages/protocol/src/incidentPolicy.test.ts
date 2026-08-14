import { describe, expect, it } from 'vitest';
import { PolicyOverrideSchema, PolicySchema, sparsifyPolicy } from './credentials.js';
import { IncidentPolicySchema } from './incident.js';

/**
 * Incident convergence increment 2 §5 — the knobs become per-team admin config, replacing increment
 * 1's hardcoded CLUSTER_THRESHOLD.
 */
describe('IncidentPolicySchema', () => {
  it('parse({}) reproduces increment 1 exactly', () => {
    // Unlike `loops`, this block does NOT default off: increment 1 already shipped clustering ON for
    // every team, so an off default would silently REMOVE shipped behaviour at upgrade. The knob
    // exists to let a team opt OUT, which is the opposite direction from the loop switches.
    expect(IncidentPolicySchema.parse({})).toEqual({
      enabled: true,
      cluster_threshold: 2,
      claim_window_ms: 600_000,
      fallback_role: 'platform',
      wake_on_route: false,
      wake_on_resolve: false,
    });
  });

  it('defaults both wake knobs OFF — spend is opt-in even when the spec wanted it on', () => {
    const p = IncidentPolicySchema.parse({});
    expect(p.wake_on_route).toBe(false);
    expect(p.wake_on_resolve).toBe(false);
  });

  it('refuses a threshold below 2 — one seat is not a cluster', () => {
    expect(IncidentPolicySchema.safeParse({ cluster_threshold: 1 }).success).toBe(false);
    expect(IncidentPolicySchema.safeParse({ cluster_threshold: 0 }).success).toBe(false);
    expect(IncidentPolicySchema.safeParse({ cluster_threshold: 3 }).success).toBe(true);
  });

  it('refuses a negative claim window', () => {
    expect(IncidentPolicySchema.safeParse({ claim_window_ms: -1 }).success).toBe(false);
    // Zero is legal and means "assign at once" — a team that wants role routing without the wait.
    expect(IncidentPolicySchema.safeParse({ claim_window_ms: 0 }).success).toBe(true);
  });
});

describe('the incident block inside team policy (ADR 185 posture)', () => {
  it('materializes for every existing team on read, with no migration', () => {
    expect(PolicySchema.parse({}).incident).toEqual(IncidentPolicySchema.parse({}));
  });

  it('is sparse through the override schema, not densified', () => {
    // The ADR 185 bug, one level down: a top-level .partial() alone leaves a PRESENT incident block
    // dense, so the first write of one knob would bake every default in and kill the schema default
    // for that team forever.
    const parsed = PolicyOverrideSchema.parse({ incident: { cluster_threshold: 3 } });
    expect(parsed.incident).toEqual({ cluster_threshold: 3 });
  });

  it('sparsifyPolicy strips incident keys that equal their default', () => {
    expect(
      sparsifyPolicy({
        incident: { enabled: true, cluster_threshold: 3, fallback_role: 'platform' },
      }),
    ).toEqual({ incident: { cluster_threshold: 3 } });
  });

  it('sparsifyPolicy drops the block entirely when nothing was chosen', () => {
    expect(sparsifyPolicy({ incident: { enabled: true, cluster_threshold: 2 } })).toEqual({});
  });
});
