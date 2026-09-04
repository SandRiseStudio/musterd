/*
 * Intents check — a forward reference names its disposition, or the build says so.
 *
 *   pnpm intents:check
 *
 * ADR 373 increment 1. The gate scans three surfaces for sentences that promise future work and
 * fails when one carries no `Follows-up:` line:
 *
 *   docs/decisions/**            — Consequences above all; ADR 354's "Left for a sibling lane" is
 *                                  the instance this exists for, and no sibling lane was opened.
 *   docs/wiki/**                 — where the "designed and not built" lists live.
 *   content/roadmap.data.ts      — every `building:` string names a remainder by construction.
 *
 * Code comments are deliberately NOT scanned (ADR 373 §Decision): a phrase list that must survive
 * ordinary engineering prose is a much noisier problem than one surviving four document genres, and
 * the ADR declines to guess at that noise floor. `census.ts`'s "increment 3 will auto-provision" is
 * therefore a known miss, on purpose.
 *
 * Three legal dispositions — a lane id, `deferred — <trigger> (<date>)`, `none — <why> (<date>)`.
 * A deferral with a named trigger is a COMPLETE answer, not a lesser one: ADR 272 §5 is the model,
 * whose reopen trigger is measured and has vacuously never fired, which is exactly why nobody keeps
 * rediscovering it as a gap. Silence is the only shape refused.
 *
 * Runs on Node's native TypeScript (no build step, no deps), like its sibling gates.
 */
import { collectForwardReferences } from './intents-corpus.ts';
import { FORWARD_BASELINE, failures, measureCoverage } from './intents.ts';

const refs = collectForwardReferences();
const bad = failures(refs, FORWARD_BASELINE);
const cov = measureCoverage(refs, FORWARD_BASELINE);

for (const r of bad) {
  const why =
    r.disposition?.kind === 'malformed'
      ? `malformed \`Follows-up:\` — ${r.disposition.why}`
      : 'promises future work and names no disposition';
  process.stderr.write(
    `✗ ${r.file}:${r.line} — ${why}\n` +
      `    matched: "${r.phrase}"\n` +
      `    line:    ${r.text}\n` +
      `    add one of:  Follows-up: <lane-id>  |  Follows-up: deferred — <trigger> (YYYY-MM-DD)  |  Follows-up: none — <why> (YYYY-MM-DD)\n`,
  );
}

for (const rot of cov.rot) {
  process.stderr.write(
    `✗ FORWARD_BASELINE — stale entry, protects nothing any more: "${rot}"\n` +
      `    the phrase is gone from that file; drop the entry (ADR 296's baseline-rot rule)\n`,
  );
}

if (bad.length > 0 || cov.rot.length > 0) {
  process.stderr.write(
    `\n${bad.length} undisposed forward reference(s), ${cov.rot.length} stale baseline entr(ies).\n`,
  );
  process.exit(1);
}

// The meter is printed on every run and NEVER gates (ADR 373; the DEFECT_RE precedent). A green
// line means "no forward reference in a NAMED shape is undisposed" — never "every intention is
// tracked". `FORWARD_RE` is hand-kept and will go stale; this number is how far short it falls.
const real = cov.matched - cov.noise;
const precision = cov.matched === 0 ? 100 : Math.round((real / cov.matched) * 100);
process.stdout.write(
  `✓ intents: ${cov.matched} match(es) in known shapes — ${real} real, ${cov.noise} noise ` +
    `(precision ${precision}%); ${cov.disposed} disposed, ${FORWARD_BASELINE.size} on the burn-down\n` +
    `  a floor, not an inventory: code comments are out of scope by design (ADR 373), the phrase list is ` +
    `hand-kept, and the noise labels are one seat's\n`,
);
