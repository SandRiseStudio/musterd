import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `process.exit()` right after a large stdout write drops everything past the pipe's buffer when
 * stdout is a pipe (Node writes to pipes asynchronously). Measured 2026-09-03: `musterd inbox --peek
 * --limit 0` was 42,652 lines to a file and 1,022 lines / 65,567 bytes — cut mid-word — through a
 * pipe. Every harness tool call reads the CLI through a pipe, which is how the inbox "could not
 * show what it counted". The exit must wait for both streams to flush.
 */
describe('exitAfterFlush (a piped stdout is not cut at 64 KB)', () => {
  it('delivers a 300 KB write through a pipe before exiting with the requested code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-exit-'));
    const exitModule = fileURLToPath(new URL('./exit.ts', import.meta.url));
    const script = join(dir, 'child.mjs');
    writeFileSync(
      script,
      [
        `import { exitAfterFlush } from ${JSON.stringify(exitModule)};`,
        `process.stdout.write('x'.repeat(300_000) + '\\nEND\\n');`,
        `process.stderr.write('e'.repeat(100_000) + '\\nERR\\n');`,
        `exitAfterFlush(3);`,
        `setTimeout(() => process.exit(99), 5_000);`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(3);
    expect(out.length).toBe(300_005);
    expect(out.endsWith('END\n')).toBe(true);
    expect(err.endsWith('ERR\n')).toBe(true);
  });
});
