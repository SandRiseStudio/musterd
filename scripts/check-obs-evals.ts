/*
 * Check that every in-scope ADR carries an `## Observability & Evaluation` section (ADR 052).
 *
 *   pnpm obs-evals:check   — fail (exit 1) on any in-scope ADR missing the section or its shape
 *
 * Why a CHECKER and not a generator (the ADR 043 / `check-arch-trees.ts` pattern): the section's
 * content — what spans an act emits, the eval's dataset + baseline, the named experiment — is
 * load-bearing and must be hand-authored per feature. We enforce *presence and shape* (the section
 * exists and answers Traces / Eval / Experiment, or is an explicit `n/a — <reason>`), never the
 * content. The gate guarantees the question is *asked*, not that the answer is good (ADR 052).
 *
 * Grandfathering (pragmatic): ADRs below GATE_FROM predate the gate and are exempt — 052 is the gate
 * itself and 056 already carries the section voluntarily; the rest are pre-gate history we do not
 * retrofit (ADR 052 Consequences: "from now on, features built after it carry traces + evals … no
 * retrofit"). Enforcement begins at GATE_FROM so every ADR authored after the gate complies by default.
 *
 * Shape accepted for an in-scope section:
 *   - an explicit exemption: a body containing an `n/a` token followed by a reason (non-agent-facing
 *     or purely mechanical ADRs), OR
 *   - a full answer: the body names all three of Traces, Eval, and Experiment.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ADR_DIR = join(repoRoot, 'docs', 'decisions');

/** First ADR number the gate enforces. Below this is pre-gate history (see header). */
const GATE_FROM = 60;

const SECTION_HEADING = 'Observability & Evaluation';
/** The three questions an agent-facing section must answer (ADR 051/052). */
const REQUIRED_TOPICS = ['Traces', 'Eval', 'Experiment'];

/** Every `NNN-<slug>.md` ADR file paired with its parsed number, sorted. */
function findAdrs(): { file: string; num: number }[] {
  const out: { file: string; num: number }[] = [];
  for (const entry of readdirSync(ADR_DIR)) {
    const m = /^(\d{3})-.*\.md$/.exec(entry);
    if (m) out.push({ file: join(ADR_DIR, entry), num: Number(m[1]) });
  }
  return out.sort((a, b) => a.num - b.num);
}

/** Body of the `## Observability & Evaluation` section (heading may carry a trailing `# comment`). */
function sectionBody(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(
    (l) => /^#{1,6}\s+/.test(l) && l.includes(SECTION_HEADING),
  );
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line)) break; // next heading ends the section
    body.push(line);
  }
  return body.join('\n').trim();
}

/** A section is well-shaped if it's an explicit `n/a — reason` or answers all three topics. */
function isWellShaped(body: string): boolean {
  const naMatch = /\bn\/a\b/i.exec(body);
  if (naMatch) {
    // require a reason beyond the bare token
    return body.replace(naMatch[0], '').trim().length > 0;
  }
  const lower = body.toLowerCase();
  return REQUIRED_TOPICS.every((t) => lower.includes(t.toLowerCase()));
}

let failed = false;
let checked = 0;
for (const { file, num } of findAdrs()) {
  const rel = relative(repoRoot, file);
  if (num < GATE_FROM) continue; // grandfathered: pre-gate history
  checked++;
  const text = readFileSync(file, 'utf8');
  const body = sectionBody(text);
  if (body === null) {
    failed = true;
    process.stderr.write(`✗ ${rel} — missing "## ${SECTION_HEADING}" section\n`);
    continue;
  }
  if (!isWellShaped(body)) {
    failed = true;
    process.stderr.write(
      `✗ ${rel} — "## ${SECTION_HEADING}" must answer ${REQUIRED_TOPICS.join(' / ')} ` +
        `(or be an explicit "n/a — <reason>")\n`,
    );
    continue;
  }
  process.stdout.write(`✓ ${rel} — Observability & Evaluation section present\n`);
}

if (failed) {
  process.stderr.write(
    `\nADRs from ${String(GATE_FROM).padStart(3, '0')} on must carry an "## ${SECTION_HEADING}" ` +
      `section (ADR 052): answer Traces / Eval / Experiment — Eval needs a dataset and a baseline — ` +
      `or write "n/a — <reason>" for a non-agent-facing or purely mechanical ADR.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `All ${checked} gated ADR(s) carry an Observability & Evaluation section (ADRs < ${String(GATE_FROM).padStart(3, '0')} grandfathered).\n`,
);
