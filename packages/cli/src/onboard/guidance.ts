import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GUIDANCE_CONTENT_VERSION,
  parseContentStamp,
  renderContentStamp,
  renderSkillBody,
  renderSkillFrontmatter,
  renderSlashCommand,
} from '@musterd/protocol';
import type { Harness } from './harness.js';

/**
 * File I/O for the on-demand **skill** + slash-command prompts (ADR 085 /
 * docs/decisions/085-layered-guidance-surface.md). The **pure renderers** live in `@musterd/protocol`
 * (`renderSkillBody`/`renderSlashCommand`), single-sourced with the primer; this module wraps them with
 * per-harness placement (from `Harness.guidance`), the content **stamp**, and the write/skip/remove
 * rules. Companion to `primer.ts` — same managed-file discipline, one layer down.
 *
 * ## Managed vs. user-authored
 * Unlike AGENTS.md (where the user's prose lives *around* our markers), guidance files are *wholly*
 * musterd's — so we overwrite in full. The safety rail is the **stamp**: a file we wrote carries a
 * `<!-- musterd:content vN sha256:… -->` line; a file the user hand-created does not. We overwrite only
 * stamped files (or any file with `--force`), never a stampless one we didn't write. The stamp's hash is
 * for **drift detection** (the doctor notes a hand-edit), *not* edit protection: a stamped file is
 * musterd-managed and a plain `musterd init` re-writes it, edits and all. To keep your own guidance,
 * author it in AGENTS.md (around the markers) or at a stampless path.
 */

/** The harness-neutral skill, always written and pointed at by the primer (covers Codex + any harness
 * without a native skill mechanism). */
export const CANONICAL_SKILL_PATH = '.musterd/skill/SKILL.md';

const SLASH_COMMANDS = ['standup', 'handoff', 'claim'] as const;

export interface GuidanceWriteResult {
  /** Paths written, relative to the binding folder (for the manifest + init report). */
  files: string[];
  /** Paths skipped because a stampless (user-authored) file was already there. */
  skipped: string[];
  /** The content version stamped into every written file. */
  contentVersion: number;
}

/** Short content digest stamped into a written file — hashes the renderable content (frontmatter +
 * body), never the stamp line, so the doctor can detect a later hand-edit (ADR 085). */
export function contentHash(renderable: string): string {
  return createHash('sha256').update(renderable, 'utf8').digest('hex').slice(0, 16);
}

/** Assemble a written file: renderable content + a trailing stamp line. The stamp is its own last line
 * so drift-checkers can strip it cleanly to recover the body for hashing. The hash is taken over the
 * newline-normalized `body` (the exact bytes written above the stamp), so it round-trips with
 * {@link strippedBody} — which also normalizes to a trailing newline. Hashing the raw `renderable`
 * instead would false-flag an untouched file whenever the renderable lacked a final newline (the
 * `join('\n')` renderers in `@musterd/protocol` do). */
function stamped(renderable: string): string {
  const body = renderable.endsWith('\n') ? renderable : renderable + '\n';
  return `${body}${renderContentStamp(GUIDANCE_CONTENT_VERSION, contentHash(body))}\n`;
}

/** Recover the renderable content (what {@link contentHash} was computed over) from a written file by
 * dropping its trailing managed stamp line. */
export function strippedBody(fileText: string): string {
  const withoutStamp = fileText.replace(
    /\n?<!-- musterd:content v\d+ sha256:[0-9a-f]{8,} -->\n?$/,
    '',
  );
  return withoutStamp.endsWith('\n') ? withoutStamp : withoutStamp + '\n';
}

/** Write one guidance file unless a stampless user file blocks it (absent `force`). Returns whether it
 * was written. */
function writeOne(
  dir: string,
  relPath: string,
  renderable: string,
  force: boolean,
  written: string[],
  skipped: string[],
): void {
  const abs = join(dir, relPath);
  if (existsSync(abs) && !force) {
    const existing = safeRead(abs);
    if (existing !== null && parseContentStamp(existing) === null) {
      skipped.push(relPath); // user authored this file — never clobber it
      return;
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stamped(renderable), 'utf8');
  written.push(relPath);
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Join a skill file's frontmatter + body for a given flavor (`'canonical'` ⇒ body only). */
function skillFile(flavor: 'claude-code' | 'cursor' | 'canonical', team: string): string {
  const fm = renderSkillFrontmatter(flavor);
  const body = renderSkillBody({ team });
  return fm ? `${fm}\n\n${body}` : body;
}

/**
 * Write the guidance surface into `dir`: the canonical `.musterd/skill/SKILL.md` always, plus the
 * skill + slash commands for each harness that declares `guidance` placement. Best-effort and
 * idempotent — re-running overwrites musterd's own stamped files and preserves any user-authored one.
 */
export function writeGuidance(
  dir: string,
  harnesses: Harness[],
  opts: { team: string; force?: boolean },
): GuidanceWriteResult {
  const force = opts.force ?? false;
  const written: string[] = [];
  const skipped: string[] = [];

  // Canonical, harness-neutral skill — the primer's fallback pointer target.
  writeOne(dir, CANONICAL_SKILL_PATH, skillFile('canonical', opts.team), force, written, skipped);

  for (const h of harnesses) {
    const g = h.guidance;
    if (!g) continue;
    writeOne(dir, g.skillPath, skillFile(g.frontmatter, opts.team), force, written, skipped);
    if (g.commandsDir) {
      for (const name of SLASH_COMMANDS) {
        writeOne(
          dir,
          join(g.commandsDir, `musterd-${name}.md`),
          renderSlashCommand(name),
          force,
          written,
          skipped,
        );
      }
    }
  }

  return { files: written, skipped, contentVersion: GUIDANCE_CONTENT_VERSION };
}

/** Every relative path guidance *could* occupy, across the canonical location and all harnesses — the
 * removal set for uninstall and the expected set for the doctor. */
export function guidanceTargets(harnesses: Harness[]): string[] {
  const paths = new Set<string>([CANONICAL_SKILL_PATH]);
  for (const h of harnesses) {
    const g = h.guidance;
    if (!g) continue;
    paths.add(g.skillPath);
    if (g.commandsDir)
      for (const n of SLASH_COMMANDS) paths.add(join(g.commandsDir, `musterd-${n}.md`));
  }
  return [...paths];
}

/**
 * Remove the guidance files musterd wrote (ADR 027 reversibility — `musterd uninstall`). Stamp-gated:
 * only deletes a file that carries a musterd content stamp, so a user-authored file at the same path
 * is never removed. Prunes musterd's now-empty guidance dirs. Never throws on a missing file.
 */
export function removeGuidance(dir: string, harnesses: Harness[]): { removed: string[] } {
  const removed: string[] = [];
  for (const rel of guidanceTargets(harnesses)) {
    const abs = join(dir, rel);
    const text = existsSync(abs) ? safeRead(abs) : null;
    if (text !== null && parseContentStamp(text) !== null) {
      rmSync(abs, { force: true });
      removed.push(rel);
    }
  }
  // Tidy musterd-owned dirs left empty (best-effort; leave shared dirs like .claude/commands alone
  // if the user has other files there).
  for (const rel of ['.claude/skills/musterd', '.musterd/skill']) {
    const abs = join(dir, rel);
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0)
        rmSync(abs, { recursive: true, force: true });
    } catch {
      /* advisory cleanup — never fail uninstall */
    }
  }
  return { removed };
}
