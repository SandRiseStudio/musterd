import { describe, expect, it } from 'vitest';
import { BootstrapCutoverRequestSchema, BootstrapMigrationRequestSchema } from './credentials.js';

describe('bootstrap retirement credentials (ADR 350)', () => {
  it('accepts only a strict legacy-key plus agent-seat proof', () => {
    expect(
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'msac_ada',
      }),
    ).toEqual({
      legacy_key: 'mskey_legacy',
      seat_credential: 'msac_ada',
    });
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'msac_wrong',
        seat_credential: 'msac_ada',
      }),
    ).toThrow();
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'mscr_human',
      }),
    ).toThrow();
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'msac_ada',
        seat: 'Ada',
      }),
    ).toThrow();
  });

  it('defaults cutover to readiness-gated and rejects unknown bypasses', () => {
    expect(BootstrapCutoverRequestSchema.parse({})).toEqual({ force: false });
    expect(BootstrapCutoverRequestSchema.parse({ force: true })).toEqual({ force: true });
    expect(() => BootstrapCutoverRequestSchema.parse({ force: false, yes: true })).toThrow();
  });
});
