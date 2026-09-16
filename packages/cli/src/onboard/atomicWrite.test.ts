import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from './atomicWrite.js';

describe('writeJsonAtomic', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-atomic-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('writes valid JSON with a trailing newline and leaves no stage file', () => {
    const p = join(dir(), 'hooks.json');
    writeJsonAtomic(p, { a: 1 });
    expect(readFileSync(p, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(readdirSync(dirname(p)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a failing validator leaves the original byte-identical and removes the stage file', () => {
    const p = join(dir(), 'hooks.json');
    writeFileSync(p, '{"keep":true}\n');
    expect(() => writeJsonAtomic(p, { keep: false }, () => false)).toThrow(/validation/);
    expect(readFileSync(p, 'utf8')).toBe('{"keep":true}\n');
    expect(readdirSync(dirname(p)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a value that cannot serialise leaves nothing behind', () => {
    const p = join(dir(), 'hooks.json');
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => writeJsonAtomic(p, cyc)).toThrow();
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dirname(p)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
