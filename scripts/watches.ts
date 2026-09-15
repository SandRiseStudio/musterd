/*
 * The watch record — parse and validate one pre-registered longitudinal question.
 *
 * A watch states a question, the falsifier that would settle it, the population it samples, and the
 * conditions that disqualify its own window — all BEFORE collection starts. See ADR 297 and
 * docs/superpowers/specs/2026-08-21-longitudinal-watches-design.md.
 *
 * NO YAML DEPENDENCY. ADR 002 keeps the dependency surface deliberately small and sets the
 * precedent directly: argument parsing "uses a hand-written minimal parser ... since the command
 * surface is small and fully specified". The frontmatter subset a watch uses is smaller still —
 * scalars and one block list — so it is parsed here rather than pulling in a YAML engine. (A `yaml`
 * package is present in the lockfile as a transitive of vite; depending on a transitive would be
 * worse than either choice, not better.)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Watch {
  readonly path: string;
  readonly fields: Record<string, string | string[]>;
  readonly body: string;
}

export const REQUIRED_SCALARS = [
  'question',
  'claim_ref',
  'falsifier',
  'population',
  'series',
  'cadence',
  'opened',
  'opened_by',
  'revisit_by',
  'status',
] as const;

export const STATUSES = ['open', 'resolved', 'void'] as const;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function unquote(value: string): string {
  const v = value.trim();
  const quoted = /^"(.*)"$/.exec(v)?.[1] ?? /^'(.*)'$/.exec(v)?.[1];
  return quoted ?? v;
}

/**
 * An empty scalar and the head of a block list look identical in this subset (`key:` with nothing
 * after it), so both become `[]` and {@link scalar} reports `[]` as absent. That collapse is what
 * lets `resolution:` sit empty on an open watch without a sentinel value.
 */
export function parseWatch(path: string, text: string): Watch | null {
  const m = FRONTMATTER.exec(text);
  const frontmatter = m?.[1];
  const body = m?.[2];
  if (frontmatter === undefined || body === undefined) return null;

  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;

  for (const raw of frontmatter.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const item = /^\s+-\s+(.*)$/.exec(raw)?.[1];
    if (item !== undefined && listKey !== null) {
      (fields[listKey] as string[]).push(unquote(item));
      continue;
    }

    const kv = /^([a-z_]+):\s*(.*)$/.exec(raw);
    const key = kv?.[1];
    const value = kv?.[2];
    if (key === undefined || value === undefined) continue;

    if (value.trim() === '') {
      fields[key] = [];
      listKey = key;
    } else {
      fields[key] = unquote(value);
      listKey = null;
    }
  }

  return { path, fields, body };
}

export function scalar(w: Watch, key: string): string | undefined {
  const v = w.fields[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function list(w: Watch, key: string): string[] {
  const v = w.fields[key];
  return Array.isArray(v) ? v.filter((s) => s.trim() !== '') : [];
}

/** ISO YYYY-MM-DD that is also a real calendar date — `2026-02-30` matches the shape but is not a day. */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Every rule a watch must satisfy regardless of the calendar or the diff. Errors accumulate rather
 * than throwing, so one run reports every problem in a file — the `check-controls.ts` idiom.
 */
export function validateWatch(w: Watch, opts: { repoRoot: string }): string[] {
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`${w.path} — ${msg}`);

  for (const key of REQUIRED_SCALARS) {
    if (scalar(w, key) === undefined) at(`missing required field \`${key}\`.`);
  }

  if (list(w, 'void_if').length === 0) {
    at(
      '`void_if` needs at least one condition. A watch with no way to be void is claiming its ' +
        'population cannot change — the assumption that made the ADR 166 series unreadable.',
    );
  }

  const status = scalar(w, 'status');
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) {
    at(`\`status\` must be one of ${STATUSES.join(' | ')}; found \`${status}\`.`);
  }

  const resolution = scalar(w, 'resolution');
  if (status !== undefined && status !== 'open' && resolution === undefined) {
    at(
      `\`status: ${status}\` requires a \`resolution\`. A terminal watch without a verdict is the ` +
        'silence this primitive exists to prevent.',
    );
  }
  if (status === 'open' && resolution !== undefined) {
    at('`resolution` is set while `status` is still `open`. Move the status, or drop the verdict.');
  }

  for (const key of ['opened', 'revisit_by'] as const) {
    const value = scalar(w, key);
    if (value !== undefined && !isRealDate(value)) {
      at(`\`${key}\` must be a real ISO date (YYYY-MM-DD); found \`${value}\`.`);
    }
  }

  const opened = scalar(w, 'opened');
  const revisitBy = scalar(w, 'revisit_by');
  if (opened && revisitBy && isRealDate(opened) && isRealDate(revisitBy) && revisitBy <= opened) {
    at(`\`revisit_by\` (${revisitBy}) must be after \`opened\` (${opened}).`);
  }

  const claimRef = scalar(w, 'claim_ref');
  if (claimRef !== undefined && !existsSync(join(opts.repoRoot, claimRef))) {
    at(
      `\`claim_ref\` points at \`${claimRef}\`, which does not exist. It is the post-back target — ` +
        'a resolution has to land somewhere a reader already goes.',
    );
  }

  return errors;
}
