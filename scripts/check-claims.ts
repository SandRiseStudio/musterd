/*
 * Check that stranger-facing surfaces scope the naming claim (ADR 320 §5a, #1537).
 *
 *   pnpm claims:check   — fail (exit 1) on an unscoped naming claim in a gated file
 *
 * WHY THIS IS A GATE AND NOT A THIRD FIX. #1537 scoped the claim across nine files on
 * 2026-09-16 after a cross-family security read. It regrew twice in places that sweep could
 * not see: the homepage card whose FIRST SENTENCE #1537 itself scoped, leaving the heading
 * and the tail standing (fixed 2026-09-18, #1561), and then the README hero, the launch
 * post's heading and body, the blog draft and the one-slide brief (this lane). Three
 * hand-sweeps of one sentence family is the definition of a rule that wants a check.
 *
 * WHAT IS ACTUALLY WRONG WITH THE UNSCOPED FORM. "Every act has a name on it" is true only
 * of acts the daemon ACCEPTED. It says nothing about the shell, filesystem, network or tool
 * calls musterd never sees — which is most of what a frightened reader is asking about.
 * Unscoped, it promises exactly the containment ADR 320 decision 5 refuses. Two independent
 * security reads reached this same family in September without having seen each other's
 * answers (wanderer 01M2RDQYCG, ghost 01M2RNPSF2).
 *
 * MENTIONS ARE NOT USES. Fenced code, comments and the rule's own documentation are stripped
 * before matching: a gate that fails when you DOCUMENT it teaches you to document it less
 * clearly, which happened twice on #1561 before ryder named it (act 01M2TXB7VD). Suppress a
 * deliberate prose use line-level with `<!-- claims:ok -->`.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

/**
 * Surfaces a stranger reads. Deliberately NOT the whole repo.
 *
 * ADRs are excluded on purpose: they are decision records, their implementers retain
 * authorship, and ADR 320 already carries its own dated correction of this exact sentence.
 * Quoting the wrong form in order to overturn it is the normal shape of a decision record.
 */
const GATED: string[] = [
  'README.md',
  'docs/launch-post.md',
  'docs/brand',
  'packages/web/content',
  'packages/web/src/components/site',
];

/** Files under a gated directory that are still not stranger-facing. */
const SKIP = /(?:\.test\.[tj]sx?|\.png|\.jpg|\.svg|\.woff2?|\.ico)$/;

interface Ban {
  re: RegExp;
  why: string;
  instead: string;
}

const BANS: Ban[] = [
  {
    re: /who did what is never a question/i,
    why: 'promises the containment ADR 320 decision 5 refuses — tool use IS the question, and musterd never sees it',
    instead: '“Every act on the roster has a name on it”',
  },
  {
    re: /(?:nothing|no one|nobody)[^.\n]{0,40}\bis anonymous\b|\bno anonymous workers?\b/i,
    why: 'an absolute claim about anonymity that the roster cannot make for anything off it',
    instead: '“musterd names the work that goes through the team; it does not contain the agent”',
  },
  {
    /*
     * Only when "every act" is doing NAMING work. The first draft of this rule banned the
     * bare phrase and fired on six sentences that were not the claim at all — "every act,
     * decision record and merge lands in the open repository" is about the repo being
     * public, not about who owns an act. A gate with six false positives on its first run
     * gets suppressed everywhere and then catches nothing.
     */
    re: /\bevery act\b(?!\s+on (?:the|that) roster\b)[^.!?]{0,60}?\b(?:has a name|carries a (?:member|named)|names its member|carries a name)\b/i,
    why: 'unscoped “every act” as a naming claim — true only of acts the daemon accepted',
    instead: '“every act on the roster …”',
  },
  {
    re: /\bthe record holds what the harness observed\b/i,
    why: 'reads as a tool-call transcript; what is attested is which model occupied a seat, at connect time',
    instead: '“who occupies a seat is what the harness observed, not what the agent declared”',
  },
];

/**
 * An unbalanced set of code fences means this checker CANNOT tell code from prose in the file,
 * and the honest answer is to say so rather than to report a pass.
 *
 * Found by mutation control on this check's own first run: README.md opened with a stray bare
 * fence (line 1, present since the first docs commit), so the naive pair-stripping below
 * swallowed everything to the next fence — including the hero paragraph this whole lane exists
 * to correct. Every mutation planted in that region reported GREEN. A gate that silently skips
 * the most important surface it has is worse than no gate, because it is trusted.
 */
function unbalancedFences(source: string): number | null {
  const marks = source.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
  return marks % 2 === 0 ? null : marks;
}

/**
 * Strip what is a MENTION rather than a USE: fenced code, HTML and line comments, JSDoc, and —
 * the case that matters most here — backticked and double-quoted spans.
 *
 * QUOTED SPANS ARE WHY THIS EXISTS. The document that DEFINES these bans has to write them out
 * in order to forbid them: `security-position.md` §3 is a numbered list of the exact sentences
 * nobody may ship. Without this, the rulebook fails the rule, five times, and the only ways out
 * are to suppress the canonical list or to paraphrase the bans until they stop being quotable —
 * both of which destroy the thing being protected. `check-vocab.ts` reached the same conclusion
 * first and states it plainly: backticks and double-quoted spans are mentions.
 */
function prose(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/[“"][^”"\n]*[”"]/g, (m) => ' '.repeat(m.length));
}

function walk(abs: string, out: string[]): void {
  const st = statSync(abs);
  if (st.isFile()) {
    if (!SKIP.test(abs)) out.push(abs);
    return;
  }
  for (const entry of readdirSync(abs)) walk(join(abs, entry), out);
}

const files: string[] = [];
for (const target of GATED) walk(join(REPO_ROOT, target), files);

const failures: string[] = [];
for (const abs of files) {
  const raw = readFileSync(abs, 'utf8');
  const odd = unbalancedFences(raw);
  if (odd !== null) {
    failures.push(
      `${relative(REPO_ROOT, abs)}\n    ${odd} code fences — an odd number, so code and prose cannot be told apart here\n    why: this checker would silently skip the unpaired region instead of reading it\n    use: balance the fences (or close the stray one) so the file can actually be checked`,
    );
    continue;
  }
  const text = prose(raw);
  const rawLines = raw.split('\n');
  const rel = relative(REPO_ROOT, abs);
  // Newlines become spaces so a claim still reads as one sentence after prettier wraps it;
  // the offsets stay aligned, so the reported line is still where the match starts.
  const flat = text.replace(/\n/g, ' ');
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  for (const ban of BANS) {
    const re = new RegExp(
      ban.re.source,
      ban.re.flags.includes('g') ? ban.re.flags : ban.re.flags + 'g',
    );
    for (const m of flat.matchAll(re)) {
      const line = lineAt(m.index ?? 0);
      if (/claims:ok/.test(rawLines[line - 1] ?? '')) continue;
      failures.push(
        `${rel}:${line}\n    ${m[0].trim().slice(0, 110)}\n    why: ${ban.why}\n    use: ${ban.instead}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    `✗ claims:check — ${failures.length} unscoped naming claim(s) on stranger-facing surfaces:\n`,
  );
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    '  The scoped forms are ADR 320 §5a and #1537. A deliberate prose use is suppressed with `<!-- claims:ok -->`.',
  );
  process.exit(1);
}

console.log(
  `✓ claims:check — ${files.length} stranger-facing file(s) scope the naming claim (ADR 320 §5a).`,
);
