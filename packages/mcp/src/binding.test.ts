import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMcpConfig } from './config.js';

let dir: string;
let bindingPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-binding-'));
  bindingPath = join(dir, 'binding.json');
  writeFileSync(
    bindingPath,
    JSON.stringify({
      server: 'http://localhost:9999',
      team: 'lab',
      member: 'Ui',
      token: 'mskd_from_file',
      surface: 'claude-code',
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadMcpConfig identity alignment (ADR 018)', () => {
  it('falls back to the workspace binding file when env carries no identity', () => {
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    expect(cfg.member).toBe('Ui');
    expect(cfg.team).toBe('lab');
    expect(cfg.token).toBe('mskd_from_file');
    expect(cfg.server).toBe('http://localhost:9999');
  });

  it('lets MUSTERD_* env override the binding file (host-injection / hosted setups)', () => {
    const cfg = loadMcpConfig({
      MUSTERD_BINDING: bindingPath,
      MUSTERD_TEAM: 'lab',
      MUSTERD_MEMBER: 'Api',
      MUSTERD_TOKEN: 'mskd_from_env',
    });
    expect(cfg.member).toBe('Api');
    expect(cfg.token).toBe('mskd_from_env');
  });

  it('errors clearly when neither env nor a binding provides an identity', () => {
    expect(() => loadMcpConfig({})).toThrow(/no identity/);
  });
});
