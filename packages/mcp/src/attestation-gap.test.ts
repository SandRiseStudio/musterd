import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig } from './config.js';

/**
 * The attestation gap — a regression suite for a real, measured hole, written to reproduce it.
 *
 * On 2026-08-01 a live seat worked and shipped PRs all day while attesting **no model**. It was
 * correctly excluded from every acceptor pool (ADR 158 refuses a diversity claim it cannot prove),
 * silently missing from the ADR 056 diversity conclusion and the per-model loop-closure telemetry,
 * and — the part that made it last a day — indistinguishable from a healthy seat from the outside.
 *
 * The cause is an asymmetry between two ladders that are each individually correct:
 *
 *   identity  =  env  >  binding.json  >  committed workspace.json
 *   model     =  env  >  binding.json
 *
 * The committed spec deliberately carries no model (a model is a per-machine fact, not something
 * everyone who clones inherits), and ADR 165 deliberately stopped provisioning from baking
 * `MUSTERD_MODEL` (a snapshot at the top of the ladder rots and outranks every later correction).
 * Neither should be reversed. But together they mean a seat whose identity comes from the THIRD
 * source resolves a full working identity and falls off the model ladder entirely — occupying,
 * working, and attesting nothing, with nothing anywhere raising its voice.
 *
 * These tests pin the voice. Fixing the ladder itself is not on the table (see above); making the
 * hole audible at the moment it opens is.
 */

let dir: string;
let errors: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-attest-gap-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.join(' '));
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The committed, shared spec: identity, no secrets, and — by design — no model. */
const writeSpec = (): void =>
  writeFileSync(
    join(dir, '.musterd', 'workspace.json'),
    JSON.stringify({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'cursor',
      claim: { mode: 'seat', name: 'miley' },
    }),
  );

/** The per-machine binding: the same identity, plus the secrets and the model. */
const writeBinding = (model?: string): void =>
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'cursor',
      agent_key: 'mskey_test',
      claim: { mode: 'seat', name: 'miley' },
      ...(model ? { model } : {}),
    }),
  );

describe('a seat that resolves an identity but no model', () => {
  it('is the reproduction: spec-only identity occupies a named seat attesting nothing', () => {
    writeSpec();
    // The agent key rides in env — exactly how a Cursor/Codex MCP entry supplies it — so this is a
    // fully working, fully credentialed seat. Nothing here fails.
    const config = loadMcpConfig({ MUSTERD_AGENT_KEY: 'mskey_test' });

    expect(config.claim).toEqual({ mode: 'seat', name: 'miley' });
    expect(config.model).toBeUndefined();
    expect(config.modelSource).toBe('unknown');
  });

  it('says so, loudly and by name, on stderr', () => {
    writeSpec();
    loadMcpConfig({ MUSTERD_AGENT_KEY: 'mskey_test' });

    const warning = errors.join('\n');
    expect(warning).toContain('miley'); // which seat
    expect(warning).toContain('attesting no model'); // what is wrong
    expect(warning).toMatch(/MUSTERD_MODEL|binding\.json/); // how to fix it
  });

  it('warns on stderr, never stdout — stdout is the MCP stdio transport', () => {
    writeSpec();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    loadMcpConfig({ MUSTERD_AGENT_KEY: 'mskey_test' });
    expect(stdout).not.toHaveBeenCalled();
  });

  it('stays silent when the binding attests — the overwhelmingly common path', () => {
    writeSpec();
    writeBinding('claude-opus-5');
    const config = loadMcpConfig({});

    expect(config.model).toBe('claude-opus-5');
    expect(config.modelSource).toBe('binding');
    expect(errors.join('\n')).not.toContain('attesting no model');
  });

  it('stays silent when the env attests — the supported manual override', () => {
    writeSpec();
    const config = loadMcpConfig({
      MUSTERD_AGENT_KEY: 'mskey_test',
      MUSTERD_MODEL: 'gpt-5.6-luna',
    });

    expect(config.model).toBe('gpt-5.6-luna');
    expect(errors.join('\n')).not.toContain('attesting no model');
  });

  it('stays silent for a chat-mode session — it holds no seat, so it grades nothing', () => {
    // No spec, no binding: identity falls all the way through to chat. Attestation is meaningless
    // here, and warning on it would train the reader to ignore the warning that matters.
    loadMcpConfig({ MUSTERD_TEAM: 'revive', MUSTERD_AGENT_KEY: 'mskey_test' });
    expect(errors.join('\n')).not.toContain('attesting no model');
  });

  it('warns for a seat whose binding exists but carries no model either', () => {
    // Not just the spec-only path: any seat that reaches `unknown` is the same hole in the evidence.
    writeBinding(undefined);
    loadMcpConfig({});
    expect(errors.join('\n')).toContain('attesting no model');
  });
});
