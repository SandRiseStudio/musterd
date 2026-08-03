#!/usr/bin/env node

/**
 * Owner gate for the real Codex CLI acceptance test (ADR 204).
 *
 * This deliberately does not start Codex itself: the Vitest acceptance fixture owns the isolated
 * daemon and workspace. Keeping the spend gate in this tiny executable makes the opt-in auditable
 * and gives CI a harmless way to prove the gate remains closed.
 */
export function realCodexEnabled(env = process.env) {
  return env.MUSTERD_REAL_CODEX === '1' && env.MUSTERD_REAL_CODEX_CONFIRM === '1';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!realCodexEnabled()) {
    process.stderr.write(
      'real Codex acceptance is disabled; set MUSTERD_REAL_CODEX=1 and MUSTERD_REAL_CODEX_CONFIRM=1\n',
    );
    process.exit(2);
  }
  process.stdout.write('real Codex acceptance gate enabled\n');
}
