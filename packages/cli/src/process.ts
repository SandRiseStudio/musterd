import { spawnSync } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;

/** A missing binary is code 127 so callers can render it as a diagnostic check. */
export const realExec: Exec = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
