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
