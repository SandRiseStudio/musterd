/*
 * The three surfaces ADR 373 scans, shared by the gate (`check-intents.ts`) and the ingest
 * (`ingest-intents.ts`) so the two can never disagree about what counts as the corpus.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ForwardReference, findForwardReferences } from './intents.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');

/** The scanned surfaces, in the order ADR 373 names them. */
const SURFACES = [
  { dir: join(repoRoot, 'docs', 'decisions'), ext: '.md' },
  { dir: join(repoRoot, 'docs', 'wiki'), ext: '.md' },
] as const;
const ROADMAP = join(repoRoot, 'content', 'roadmap.data.ts');

function filesUnder(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

export function collectForwardReferences(): ForwardReference[] {
  const refs: ForwardReference[] = [];
  for (const { dir, ext } of SURFACES) {
    for (const file of filesUnder(dir, ext)) {
      refs.push(...findForwardReferences(relative(repoRoot, file), readFileSync(file, 'utf8')));
    }
  }
  try {
    refs.push(...findForwardReferences(relative(repoRoot, ROADMAP), readFileSync(ROADMAP, 'utf8')));
  } catch {
    // The roadmap module is the one named file rather than a glob; if it moves, the arch-trees and
    // roadmap gates say so far more loudly than this one would.
  }
  return refs;
}
