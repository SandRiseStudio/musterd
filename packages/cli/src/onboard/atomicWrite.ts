import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Stage → validate → rename (spec 2026-09-16, workspace self-heal).
 *
 * A hook-driven repair writes files no human is watching, and a malformed hooks file bricks the
 * NEXT session start silently — the harness reads it at boot and there is nobody at the keyboard
 * to notice. So the write is committed only after the staged bytes parse back and pass the
 * caller's validator; any failure leaves the original untouched and the stage removed. The stage
 * name carries the pid so two processes writing the same file cannot collide on it.
 */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  validate?: (parsed: unknown) => boolean,
): void {
  const stage = `${path}.tmp-${String(process.pid)}`;
  try {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(stage, body, { mode: 0o644 });
    const parsed: unknown = JSON.parse(readFileSync(stage, 'utf8'));
    if (validate && !validate(parsed)) throw new Error(`atomic write validation failed: ${path}`);
    renameSync(stage, path);
  } catch (err) {
    rmSync(stage, { force: true });
    throw err;
  }
}
