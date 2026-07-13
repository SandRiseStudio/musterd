import type { MemoryEnvelope } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success, sym, termWidth } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd memory [show]|save|clear` — the seat's private cross-session continuity blob (ADR 093):
 * the working state a returning occupant needs, written explicitly by the occupant at natural
 * boundaries (before a handoff, at a wrap-up, when told to wind down). One note per seat,
 * last-write-wins; headline ≤120 chars, body ≤8KB (the server rejects over-cap with the limit
 * named). Seat-scoped: readable by this seat only — no cross-seat path, admins included. The
 * delivery seam is envelope-on-occupy / body-on-demand: `musterd claim` / `musterd status` print
 * {@link renderMemoryLine}; `musterd memory` is the explicit body read.
 */
export async function memoryCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? 'show';
  const { team, http } = resolve(parsed.flags);

  if (sub === 'save') {
    const headline = flagStr(parsed.flags, 'headline');
    if (!headline) {
      throw new CliError('usage: musterd memory save --headline "<subject>" [body...]', 2);
    }
    const body = parsed.positionals.slice(1).join(' ');
    await http.saveMemory(team, { headline, ...(body ? { body } : {}) });
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true, headline }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`memory saved — your next occupy shows ${theme.accent(`"${headline}"`)}`, {
        next: 'musterd memory',
      }) + '\n',
    );
    return 0;
  }

  if (sub === 'clear') {
    await http.clearMemory(team);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true }) + '\n');
      return 0;
    }
    process.stdout.write(
      success('memory cleared', {
        next: 'musterd memory save --headline "<subject>"',
      }) + '\n',
    );
    return 0;
  }

  if (sub !== 'show') {
    throw new CliError(
      'usage: musterd memory [show] | save --headline "<subject>" [body...] | clear',
      2,
    );
  }

  // The explicit body read. A seat with nothing saved is a normal state, not an error exit.
  let mem: { headline: string; body: string; saved_at: number };
  try {
    mem = await http.getMemory(team);
  } catch (err) {
    if (err instanceof CliError && err.code === 'not_found') {
      process.stdout.write(
        theme.meta(
          'no memory saved for this seat yet — nothing to carry over. musterd memory save --headline "<subject>"',
        ) + '\n',
      );
      return 0;
    }
    throw err;
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(mem) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent('memory')} ${theme.meta(`(saved ${ago(Date.now() - mem.saved_at)} ago)`)} — ${mem.headline}\n`,
  );
  if (mem.body) process.stdout.write(mem.body + (mem.body.endsWith('\n') ? '' : '\n'));
  return 0;
}

/**
 * The one-line continuity pointer `musterd claim` / `musterd status` print (ADR 093 §3) — headline +
 * age, never the body, so the returning occupant makes an informed fetch decision.
 *
 * `compact` is the `status` header form: glyph-led and clipped to one line. The long prose form
 * (`saved memory from 6d ago: "…" — \`musterd memory\` to load it`) is right when it is the *only*
 * thing on screen after a claim, and is the single noisiest line in a header that has five other
 * things to say — so the header gets a version that states the same facts and sits down.
 */
export function renderMemoryLine(
  env: MemoryEnvelope,
  now = Date.now(),
  opts: { compact?: boolean; width?: number } = {},
): string {
  const age = ago(now - env.saved_at);
  if (!opts.compact) {
    return theme.meta(
      `saved memory from ${age} ago: "${env.headline}" — \`musterd memory\` to load it`,
    );
  }
  const width = opts.width ?? termWidth();
  const lead = `${sym.goal} memory ${sym.dot} ${age}  `;
  const tail = `  ${sym.arrow} musterd memory`;
  const room = Math.max(16, width - lead.length - tail.length - 2);
  const headline =
    env.headline.length > room ? env.headline.slice(0, room - 1) + sym.more : env.headline;
  return theme.meta(`${lead}"${headline}"${tail}`);
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}
