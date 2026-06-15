import type {
  Activity,
  Envelope,
  MemberKind,
  MemberSummary,
  PresenceStatus,
} from '@musterd/protocol';
import { clock, theme } from './theme.js';

export type KindOf = (name: string) => MemberKind;

const COLS = 80;
/** A status older than this is shown with its age (`working: x · Nm`) to signal it may be stale. */
const STALE_AFTER_MS = 5 * 60_000;

/** The ASCII wordmark banner + tagline (brand.md). Mirrors the Figma `cmp/banner`. */
export function renderBanner(): string {
  const word = [
    ' _ __ ___  _   _ ___ | |_ ___ _ __ __| |',
    "| '_ ` _ \\| | | / __|| __/ _ \\ '__/ _` |",
    '| | | | | | |_| \\__ \\| ||  __/ | | (_| |',
    '|_| |_| |_|\\__,_|___/ \\__\\___|_|  \\__,_|',
  ].join('\n');
  return `${theme.accent(word)}\n${theme.meta('muster your agents and humans into persistent teams')}`;
}

/** A recipient label for a message row: `→ Lin`, `→ @team`, `→ @broadcast`. */
function toLabel(to: Envelope['to'], kindOf: KindOf): string {
  if (to.kind === 'team') return theme.meta('→ @team');
  if (to.kind === 'broadcast') return theme.meta('→ @broadcast');
  return theme.meta('→ ') + theme.memberName(to.name, kindOf(to.name));
}

/** One message row: `HH:MM name [act] → to  body` with hanging-indent wrap at 80 cols. */
export function renderMessageRow(
  env: Envelope,
  kindOf: KindOf,
  opts: { unread?: boolean } = {},
): string {
  const marker = opts.unread ? theme.accent('▌') + ' ' : '  ';
  const head = `${theme.meta(clock(env.ts))} ${theme.memberName(env.from, kindOf(env.from))} ${theme.actBadge(env.act)} ${toLabel(env.to, kindOf)}`;
  const indent = '    ';
  const body = wrap(env.body, COLS - indent.length)
    .map((line, i) => (i === 0 ? `${indent}${line}` : `${indent}${line}`))
    .join('\n');
  return env.body ? `${marker}${head}\n${body}` : `${marker}${head}`;
}

/**
 * The roster table for `status`: MEMBER KIND ROLE LIFECYCLE ACTIVITY.
 * ACTIVITY is last because its `working: …` label is unbounded — a free-flowing final
 * column never collides with the columns after it.
 */
export function renderStatusTable(members: MemberSummary[], now = Date.now()): string {
  const header = theme.meta(
    pad('MEMBER', 14) + pad('KIND', 8) + pad('ROLE', 14) + pad('LIFECYCLE', 18) + 'ACTIVITY',
  );
  const rows = members.map((m) => {
    const name = theme.memberName(m.name, m.kind);
    const label = activityLabel(m, now);
    const dot = activityOf(m) === 'offline' ? 'offline' : 'online';
    const activity = `${theme.presenceDot(dot)} ${theme.meta(label)}`;
    const lifecycle =
      m.lifecycle === 'until' && m.lifecycle_until
        ? `until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`
        : m.lifecycle;
    return (
      padVisible(name, m.name, 14) +
      pad(m.kind, 8) +
      pad(m.role || '—', 14) +
      pad(lifecycle, 18) +
      activity
    );
  });
  return [header, ...rows].join('\n');
}

/** Activity, falling back to a presence-derived value for older rosters that predate the field. */
function activityOf(m: MemberSummary): Activity {
  return m.activity ?? (m.presence === 'offline' ? 'offline' : 'online');
}

/** The text after the dot: `offline` / `online via cli` / `working: refactoring auth · 18m`. */
function activityLabel(m: MemberSummary, now: number): string {
  const activity = activityOf(m);
  if (activity === 'offline') return 'offline';
  if (activity === 'working' && m.state) {
    const stale = m.last_status_at != null && now - m.last_status_at >= STALE_AFTER_MS;
    const age = stale && m.last_status_at != null ? ` · ${ageLabel(m.last_status_at, now)}` : '';
    return `working: ${m.state}${age}`;
  }
  const surface = m.presences[0]?.surface;
  return surface ? `online via ${surface}` : 'online';
}

/** Coarse human age: `18m` / `2h` / `3d`. */
function ageLabel(since: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - since) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function renderPresence(status: PresenceStatus, surface?: string): string {
  const dot = theme.presenceDot(status);
  const label = surface && status !== 'offline' ? `${status} via ${surface}` : status;
  return `${dot} ${theme.meta(label)}`;
}

// ---- helpers ----

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

/** Pad a colorized string using its visible (uncolored) length, always leaving ≥1 trailing space. */
function padVisible(colored: string, plain: string, width: number): string {
  const extra = Math.max(1, width - plain.length);
  return colored + ' '.repeat(extra);
}
