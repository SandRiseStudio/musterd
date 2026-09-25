import { isMusterdCredential } from '@musterd/protocol';

type Level = 'info' | 'warn' | 'error';

export interface LogFields {
  msg: string;
  team?: string;
  member?: string;
  act?: string;
  conn?: string;
  [k: string]: unknown;
}

function emit(level: Level, fields: LogFields): void {
  if (process.env['MUSTERD_SILENT'] === '1') return;
  const line = JSON.stringify({ ts: Date.now(), level, ...fields });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** Structured single-line JSON logger (07-conventions format). Never logs tokens. */
export const log = {
  info: (fields: LogFields) => emit('info', fields),
  warn: (fields: LogFields) => emit('warn', fields),
  error: (fields: LogFields) => emit('error', fields),
};

const REDACTED = '[redacted]';

/**
 * A request path made safe to log or echo (hard rule 5). The path is the one part of a request the
 * log keeps, and a remote MCP connector URL carries its secret there: every segment under an `mcp`
 * segment is redacted (`/mcp/<token>`, ADR 446's `/mcp/:team`, its `.well-known` twin), and so is
 * any credential-shaped segment anywhere, checked percent-decoded so `%6Dscr_` cannot slip past.
 */
export function redactPath(path: string): string {
  let underMcp = false;
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      if (underMcp) return REDACTED;
      if (segment.toLowerCase() === 'mcp') {
        underMcp = true;
        return segment;
      }
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Malformed encoding: judge the raw segment.
      }
      return isMusterdCredential(decoded) ? REDACTED : segment;
    })
    .join('/');
}
