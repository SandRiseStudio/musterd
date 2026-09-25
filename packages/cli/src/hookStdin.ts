/**
 * Drain a hook's stdin with a hard timeout. Every harness hook pipes one JSON object in and closes
 * the stream; a wiring mistake (no JSON piped, a shell that keeps stdin open) must never hang the
 * tool call the hook rides on, so the read resolves with whatever arrived when the timer fires.
 * Shared by the gate, the session capture, the Codex hook and the trace tap (ADR 247: one transform,
 * one home).
 */
export function readHookStdin(timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
