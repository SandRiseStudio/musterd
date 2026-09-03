/**
 * Exit once stdout and stderr have drained. `process.exit()` right after a large write drops
 * whatever the pipe has not taken yet — Node writes to pipes asynchronously, and a pipe is what every
 * harness tool call and every `| less` reads the CLI through. Measured 2026-09-03: `musterd inbox
 * --peek --limit 0` was 42,652 lines to a file and 1,022 lines / 65,567 bytes, cut mid-word, through a
 * pipe — the reason the inbox "could not show what the banner counted". A zero-length write's
 * callback fires only after everything queued before it has been flushed.
 */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}
