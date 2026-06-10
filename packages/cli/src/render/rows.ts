import type { Envelope, MemberKind, MemberSummary, PresenceStatus } from '@musterd/protocol';
import { clock, theme } from './theme.js';

export type KindOf = (name: string) => MemberKind;

const COLS = 80;

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

/** The roster table for `status`: MEMBER KIND ROLE PRESENCE LIFECYCLE. */
export function renderStatusTable(members: MemberSummary[]): string {
  const header = theme.meta(
    pad('MEMBER', 14) + pad('KIND', 8) + pad('ROLE', 14) + pad('PRESENCE', 28) + 'LIFECYCLE',
  );
  const rows = members.map((m) => {
    const name = theme.memberName(m.name, m.kind);
    const presence = renderPresence(m.presence, m.presences[0]?.surface);
    const lifecycle = m.lifecycle === 'until' && m.lifecycle_until
      ? `until ${new Date(m.lifecycle_until).toISOString().slice(0, 10)}`
      : m.lifecycle;
    return (
      padVisible(name, m.name, 14) +
      pad(m.kind, 8) +
      pad(m.role || '—', 14) +
      padVisible(presence, presencePlain(m.presence, m.presences[0]?.surface), 28) +
      lifecycle
    );
  });
  return [header, ...rows].join('\n');
}

export function renderPresence(status: PresenceStatus, surface?: string): string {
  const dot = theme.presenceDot(status);
  const label = surface && status !== 'offline' ? `${status} via ${surface}` : status;
  return `${dot} ${theme.meta(label)}`;
}

function presencePlain(status: PresenceStatus, surface?: string): string {
  const label = surface && status !== 'offline' ? `${status} via ${surface}` : status;
  return `${status === 'offline' ? '○' : '●'} ${label}`;
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
