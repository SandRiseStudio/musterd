import pc from 'picocolors';
import type { Act, MemberKind, PresenceStatus } from '@musterd/protocol';

/** ANSI color roles, mapped per brand.md §2. Honors NO_COLOR / non-TTY via picocolors. */
export const theme = {
  accent: (s: string) => pc.bold(pc.yellow(s)),
  memberName: (name: string, kind: MemberKind) =>
    kind === 'agent' ? pc.cyan(name) : pc.magenta(name),
  meta: (s: string) => pc.gray(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  err: (s: string) => pc.red(s),

  presenceDot(status: PresenceStatus): string {
    if (status === 'online') return pc.green('●');
    if (status === 'away') return pc.yellow('●');
    return pc.gray('○');
  },

  actBadge(act: Act): string {
    const label = `[${act}]`;
    if (act === 'request_help') return pc.bold(pc.yellow(label));
    if (act === 'decline') return pc.red(label);
    return pc.dim(pc.white(label));
  },
};

/** A short HH:MM timestamp in the meta color. */
export function clock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
