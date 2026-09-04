/*
 * Forward references: the sentences that promise future work, and the line that disposes of them.
 *
 * ADR 373 increment 1. musterd tracks work IN FLIGHT (a lane) and MISSIONS (a goal). An intention
 * that has been RECORDED and not started has one representation — a Seed (ADR 291/319) — and it is
 * wired to a phone number and a Slack channel. Intentions recorded in this repo's own documents
 * reach nothing, so on 2026-09-03 a sweep found nine of them with no lane, no goal and no code,
 * among them ADR 354's own "Left for a sibling lane" and `census.ts`'s "increment 3 will
 * auto-provision".
 *
 * This module is the pure half: what counts as a forward reference, what counts as disposing of
 * one, and the baseline of references that predate the gate. `check-intents.ts` is the gate.
 *
 * **The list is a floor, not an inventory.** `FORWARD_RE` is hand-kept and will go stale exactly as
 * the wiki's `DEFECT_RE` did — measured 2026-08-24, the entire "reaches nobody" family passed that
 * gate undated, and it was the family that week's findings belonged to. So this module reports its
 * own coverage and the gate prints it every run: a green `intents:check` means "no forward
 * reference in a NAMED shape is undisposed", never "every intention is tracked".
 */

/**
 * The phrasings this corpus actually uses to promise future work, harvested from
 * `docs/decisions`, `docs/wiki` and `content/roadmap.data.ts` on 2026-09-03 (counts at that date:
 * "its own lane" 18, "what remains is" 9, "not yet built" 6, "a separate lane" 3, "left for a
 * sibling lane" 2, "increment N will" 4, "a sibling lane" 2, "never built" 1).
 *
 * Written from the corpus rather than from imagination, which is the only reason the recall claim in
 * ADR 373's Eval can be checked at all.
 */
export const FORWARD_RE: RegExp[] = [
  /left for (?:a|its own) (?:sibling |separate |later )?lane/i,
  /(?:its own|a separate|a sibling|a later|another) lane\b/i,
  /what (?:remains|is left) is\b/i,
  /\bincrement \d+ will\b/i,
  /\b(?:not yet|never) built\b/i,
  /\bis the follow-?up\b/i,
  /\bfollow-?up if\b/i,
  /\bdeferred to (?:a|its own)\b/i,
];

/** The disposition line. Three legal answers; silence is the only shape the gate refuses. */
export const DISPOSITION_RE =
  /^\s*(?:\/\/\s*|[-*>]\s*)?(?:\*\*)?Follows-up:(?:\*\*)?\s*(?<body>.+?)\s*$/i;

/** A ULID as musterd mints them — Crockford base32, 26 chars. */
const LANE_ID_RE = /^`?[0-9A-HJKMNP-TV-Z]{26}`?$/;
/** `deferred` / `none` must carry BOTH a reason and a date, or they are silence with a prefix. */
/**
 * `deferred` / `none` must carry BOTH a reason and a date. The reason group is deliberately captured
 * rather than skipped over with `.*`, because `.*` matches the empty string: the previous shape
 * accepted `deferred (2026-09-03)` — a date with no reopen trigger — while the comment beside it
 * claimed both were required (gptbot's decline of lane 01M1MNTTNC, 2026-09-03).
 *
 * That gap mattered more than a normal regex slip. A deferral whose trigger is missing is
 * indistinguishable from forgetting, which is the exact condition ADR 373 exists to refuse; the gate
 * would have stamped the failure mode as compliant.
 */
const REASONED_RE = /^(?<kind>deferred|none)\b(?<reason>[^()]*)\(\d{4}-\d{2}-\d{2}\)\s*$/iu;

/** A reason is text a reader can act on — at least one letter, not punctuation or an em dash. */
const HAS_REASON = /\p{L}/u;

export type Disposition =
  | { kind: 'lane'; lane: string }
  | { kind: 'deferred' | 'none' }
  | { kind: 'malformed'; why: string };

/** Parse the body of a `Follows-up:` line. Exported so the tests can pin each refusal. */
export function parseDisposition(body: string): Disposition {
  const trimmed = body.trim();
  if (LANE_ID_RE.test(trimmed)) return { kind: 'lane', lane: trimmed.replace(/`/g, '') };
  const reasoned = REASONED_RE.exec(trimmed);
  if (reasoned?.groups && HAS_REASON.test(reasoned.groups['reason'] ?? '')) {
    return { kind: reasoned.groups['kind']!.toLowerCase() === 'deferred' ? 'deferred' : 'none' };
  }
  if (/^(?:deferred|none)\b/i.test(trimmed)) {
    return {
      kind: 'malformed',
      why: 'a deferral needs a reopen trigger AND a date — `deferred — <trigger> (YYYY-MM-DD)`',
    };
  }
  return {
    kind: 'malformed',
    why: 'expected a lane id, `deferred — … (date)`, or `none — … (date)`',
  };
}

/** How many lines after a forward reference a `Follows-up:` may sit. Prose wraps; a disposition
 *  three paragraphs away is not attached to anything a reader would connect it to. */
export const DISPOSITION_WINDOW = 4;

export interface ForwardReference {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The matched phrase, for the message — never the whole line, which can be a paragraph. */
  phrase: string;
  /** The line's text, trimmed and bounded. */
  text: string;
  disposition: Disposition | null;
}

/**
 * Every forward reference in one file, each carrying the disposition that follows it (or null).
 *
 * A line that is ITSELF a disposition never counts as a forward reference — `Follows-up: deferred —
 * … its own lane (2026-09-03)` would otherwise match `a separate lane` and demand a disposition for
 * the disposition.
 */
/**
 * A `building:` string in the roadmap data is a forward reference BY CONSTRUCTION, whatever words it
 * happens to use: `roadmap-truth:check` rule 3 only permits the field on an item whose freezing ADR
 * is accepted while the item is unshipped, so its whole job is to name what is left.
 *
 * This is a STRUCTURAL rule, not another phrase, and it exists because the phrase list missed a real
 * one: `ledger-seats.building` opens "increments 3–5 — remaining platform services…" and matches
 * nothing in {@link FORWARD_RE}. Widening the list to catch it (`increments? \d+`) would have
 * matched every incidental mention of an increment in the corpus. When a genre of line is a promise
 * by definition, say so once instead of guessing at how people phrase it.
 */
const STRUCTURAL_RE = /^\s*building:/i;

export function findForwardReferences(file: string, text: string): ForwardReference[] {
  const lines = text.split('\n');
  const out: ForwardReference[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (DISPOSITION_RE.test(line)) continue;
    const structural = STRUCTURAL_RE.exec(line);
    const hit = structural ?? FORWARD_RE.map((re) => re.exec(line)).find((m) => m !== null);
    if (!hit) continue;
    // A structural `building:` key usually sits alone on its line with the string wrapped below it.
    // Five such keys share the text "building:", so keyed on the line alone they are one reference
    // — one baseline entry, one Seed — for five different promises (2026-09-03: the first ingest
    // made one Seed of five). Carry the string's first line so the text names WHICH promise.
    const text =
      structural && line.trim() === structural[0].trim()
        ? `${line.trim()} ${(lines.slice(i + 1).find((l) => l.trim() !== '') ?? '').trim()}`
        : line.trim();
    out.push({
      file,
      line: i + 1,
      phrase: hit[0],
      text: text.slice(0, 120),
      disposition: dispositionNear(lines, i),
    });
  }
  return out;
}

/**
 * The `Follows-up:` attached to the reference at `i`: the line immediately ABOVE it, or one of the
 * {@link DISPOSITION_WINDOW} lines below.
 *
 * The line above is not symmetry for its own sake — it is the only position that works for a
 * multi-line construct. A roadmap `building:` string runs to five wrapped lines, so a disposition
 * placed "just after" it falls outside the window before the string even ends, and above the key is
 * where a TypeScript comment naturally goes anyway.
 */
function dispositionNear(lines: string[], i: number): Disposition | null {
  for (let j = Math.max(0, i - 1); j <= Math.min(i + DISPOSITION_WINDOW, lines.length - 1); j++) {
    const m = DISPOSITION_RE.exec(lines[j]!);
    if (m?.groups?.['body']) return parseDisposition(m.groups['body']);
  }
  return null;
}

/**
 * Forward references that predate the gate, as `file:phrase` — the ADR 296 pattern exactly
 * (`DESIGN_BASELINE`): a burn-down, not a silent exemption. Keyed on the phrase rather than the line
 * number so ordinary editing above it does not spuriously un-baseline it.
 *
 * An entry naming a file that no longer holds that phrase is ROT — the exemption stays counted while
 * protecting nothing — and the gate reports it, the way `baselineRot` does for vocab.
 */
const BASELINE_GENUINE: readonly string[] = [
  'docs/decisions/027-non-invasive-harness-coexistence.md::`init`-undo / per-folder uninstall that removes exactly what',
  'docs/decisions/047-service-roster-guard.md::follow-up if dogfood shows it bites.',
  'docs/decisions/055-issue-a-seat-no-dead-ends.md::binding, so it does not clobber — the key property. **follow',
  'docs/decisions/066-claim-clobber-guard.md::**experiment** — named, not yet built: once batond lands, a/',
  'docs/decisions/091-mast-views-report-coordination.md::per-recipient delivery ledger, adr 090, #114) are on main. w',
  'docs/decisions/164-session-attested-presence.md::out of scope here, and tracked as its own lane rather than p',
  'docs/decisions/167-harness-native-session-messaging.md::observability one, and it deserves its own lane rather than ',
  'docs/decisions/173-absent-is-not-unknown.md::reach; exact in shape. filed as its own lane rather than fix',
  'docs/decisions/173-absent-is-not-unknown.md::index on `action`, which hits both forms equally, tracked as',
  'docs/decisions/175-mcp-spec-2026-07-28-readiness.md::version and does not start now. the adoption checklist below',
  'docs/decisions/184-dataset-consent-and-redaction.md::- **does not build the exporter.** this is the posture and t',
  'docs/decisions/189-wake-pool-wakeability.md::and dispatch cannot — not a safety hole. adr 179 increment 5',
  'docs/decisions/189-wake-pool-wakeability.md::`not_enrolled`, so adr 179 increment 5 will not pick them un',
  'docs/decisions/200-credential-custody-and-the-real-use-gate.md::not chosen here. this adr sets the requirement and the gate;',
  'docs/decisions/232-ledger-seats-every-actor-on-the-roster.md::ledger seat. "job gone" only applies to the four platform la',
  'docs/decisions/233-owed-reviews-in-the-brief.md::counterpart picker is over-concentrating and that is a separ',
  'docs/decisions/235-self-close-sanction-needs-a-backstop.md::load. that is a separate defect from this one, and it wants ',
  'docs/decisions/250-loops-one-week-in-judgment-throughput.md::ordered by judgment recovered per unit of build. each item l',
  'docs/decisions/259-memory-git-truth-derived-indexes.md::- **claude code file memory — migrate, then demote** (increm',
  "docs/decisions/276-the-acceptance-queue-reports-its-own-state.md::asks reachable at all, and narrowing it touches adr 147's ad",
  'docs/decisions/336-attestation-follows-the-slot.md::guard, and the wake guard runs once, before spawn. that is a',
  'docs/decisions/354-wake-lease-file-channel.md::the fact, and is the follow-up if this residual is ever obse',
  'docs/decisions/354-wake-lease-file-channel.md::kill. left for a sibling lane; this adr fixes the attestatio',
  'docs/wiki/agent-permission-enforcement-patterns.md::- **not yet built, worth remembering**: per-call correlation',
  'docs/wiki/federation-data-census.md::| `seeds` (lifecycle) | 2 | relay-ingested per daemon, or re',
  'docs/wiki/wake-leases.md::**still true, and not fixed here:** the actuator will kill a',
  "content/roadmap.data.ts::'m1–m3 landed (#359/#360) and hand-run; what remains is m4–m",
  "content/roadmap.data.ts::'the export path shipped 2026-08-19 (`pnpm dataset:export`, ",
  "content/roadmap.data.ts::'nothing is in flight — the toolkit migration (adr 272 §4, u",
];

const BASELINE_NOISE: readonly string[] = [
  'docs/decisions/373-a-recorded-intention-names-its-lane.md::for a sibling lane", "increment n will", "what remains is", ',
  'docs/decisions/373-a-recorded-intention-names-its-lane.md::- **recall against the pre-registered targets: 3 of 3.** adr',
  'docs/decisions/373-a-recorded-intention-names-its-lane.md::already opened ("became its own lane (`01m1d3…`)"), a set re',
  'docs/decisions/373-a-recorded-intention-names-its-lane.md::marker file"), adr 112 quoting "not yet built" as an example',
  // ^ ADR 373's own Eval section, which explains that quotations are noise, is quotations.
  'docs/decisions/111-stale-plan-detection.md::assumption another lane had already invalidated).',
  'docs/decisions/112-steward-seat.md::later, same shape, `propose`: stale prose headers ("not yet ',
  "docs/decisions/136-observer-grades-public-watch-links.md::- what remains is `to_kind in ('team','broadcast')`.",
  'docs/decisions/160-seat-session-labels.md::own text already assumed a trigger that was never built ("if',
  'docs/decisions/238-verify-waits-for-its-own-evidence.md::from that population; this removes the occupied seat. what i',
  'docs/decisions/239-foreign-paths-in-the-working-tree.md::index is gone; what remains is one empty marker file per ses',
  'docs/decisions/243-a-handoff-carries-its-own-why.md::left that set and can never be derived. what remains is ever',
  'docs/decisions/330-agent-whiteboard.md::inside its own lane. boards themselves stay out of git: muta',
  'docs/decisions/331-ordering-substrate.md::the residual, priced honestly: after the cas eliminates ever',
  'docs/decisions/338-a-finding-is-not-a-fix-request.md::became its own lane (`01m1d3hjzact6cc9kq0qr88ajs`) instead o',
  'docs/decisions/373-a-recorded-intention-names-its-lane.md::for a sibling lane", "increment n will", "what remains is", ',
  "docs/wiki/adr-338-drift-rerun.md::- **#1143 — rule 4, taking by decision.** dolly's `role.ts` ",
  'docs/wiki/command-and-tool-surface-map.md::ranked by how likely a reader is to act on the wrong meaning',
  'docs/wiki/wake-leases.md::fixed 2026-09-02 (lane 01m1g310y7): every settled run on all',
  "content/roadmap.data.ts::tone: 'next up — designed, evidence-backed, not yet built.',",
  "content/roadmap.data.ts::'the shared entry baked musterd_agent_key + musterd_grant — ",
];

/** The debt: genuine forward references that predate the gate. Burn it down; do not grow it. */
export const FORWARD_BASELINE = new Set<string>(BASELINE_GENUINE);

/**
 * The instrument's own noise — lines the shapes match that promise nothing. Kept APART from the
 * debt above so precision is a printed number rather than a feeling, and so the burn-down count
 * means what it says.
 *
 * Every entry is one of four shapes, all past-tense or descriptive: a lane that was already opened
 * ("became its own lane (`01M1D3…`)"), a set remainder ("what remains is one empty marker file"),
 * a quotation of the phrase itself (ADR 112 lists "not yet built" as an example of stale prose), or
 * UI copy. Folding these into the debt would make the backlog look larger than it is and the
 * instrument look better than it is, in one gesture.
 *
 * Labelled by ryder alone on 2026-09-03, which is the weak part of this module:
 * `defect-gate-coverage.md`'s rule is that a relabeling pass by another seat is the check, and
 * disagreement above a handful of lines means the discriminator needs sharpening, not the labeller.
 * Follows-up: deferred — a second seat relabels this set and diffs against ryder's labels (2026-09-03)
 */
export const FALSE_POSITIVE_BASELINE = new Set<string>(BASELINE_NOISE);

/**
 * Baseline key: the file plus a normalized head of the line.
 *
 * NOT the line number — ordinary editing above a reference would un-baseline everything below it.
 * NOT the phrase alone — ADR 173 carries "its own lane" twice, on different subjects, and one key
 * would exempt both, so disposing one would silently exempt the other.
 */
export function baselineKey(ref: Pick<ForwardReference, 'file' | 'text'>): string {
  return `${ref.file}::${ref.text.replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase()}`;
}

export interface Coverage {
  /** Forward references the named shapes matched. */
  matched: number;
  /** Of those, how many carry a disposition. */
  disposed: number;
  /** Of those, how many are the instrument's own noise ({@link FALSE_POSITIVE_BASELINE}). */
  noise: number;
  /** Baseline entries matching nothing any more — exemptions protecting nothing. */
  rot: string[];
}

/** The meter. It NEVER gates — it is printed so the floor is a number rather than a hope. */
export function measureCoverage(
  refs: ForwardReference[],
  baseline: Set<string> = FORWARD_BASELINE,
  noise: Set<string> = FALSE_POSITIVE_BASELINE,
): Coverage {
  const keys = new Set(refs.map(baselineKey));
  const isDisposed = (r: ForwardReference): boolean =>
    r.disposition !== null && r.disposition.kind !== 'malformed';
  return {
    matched: refs.length,
    disposed: refs.filter(isDisposed).length,
    noise: refs.filter((r) => noise.has(baselineKey(r))).length,
    rot: [...baseline, ...noise].filter((b) => !keys.has(b)),
  };
}

/** The references the gate should fail on: undisposed or malformed, and not baselined. */
export function failures(
  refs: ForwardReference[],
  baseline: Set<string> = FORWARD_BASELINE,
  noise: Set<string> = FALSE_POSITIVE_BASELINE,
): ForwardReference[] {
  return refs.filter((r) => {
    const key = baselineKey(r);
    if (baseline.has(key) || noise.has(key)) return false;
    return r.disposition === null || r.disposition.kind === 'malformed';
  });
}

/**
 * ADR 373 increment 2 — which forward references become Seeds, and under what key.
 *
 * A document-recorded intention is a Seed whose source is a repo path + anchor instead of a Slack
 * capture. The anchor is {@link baselineKey}'s text head, so the Seed's identity survives ordinary
 * editing above the line exactly as the baseline does, and a re-run of `pnpm intents:ingest`
 * captures nothing twice (the daemon is idempotent on `ref`).
 *
 *   - undisposed (baselined or not)  → an OPEN Seed: captured, never started — the tray shows it
 *   - `deferred — <trigger> (date)`  → an OPEN Seed: still an intention, with its reopen trigger
 *   - `<lane-id>`                    → a Seed born PROMOTED with `linked_lane_id`: the provenance edge
 *   - `none — <why> (date)`          → nothing: the author said no work is owed
 *   - malformed                      → nothing: the gate fails it; fix the line, not the tray
 *   - noise ({@link FALSE_POSITIVE_BASELINE}) → nothing: it promises nothing
 *
 * Capture, never interpret: the body is the line as written plus where it was written.
 */
export interface IngestCandidate {
  ref: string;
  body: string;
  lane_id?: string;
  kind: 'undisposed' | 'deferred' | 'lane';
}

/** A URL-safe anchor from the baseline key's text head: same stability, readable in a Seed tray. */
export function anchorOf(textHead: string): string {
  return textHead
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function ingestCandidates(
  refs: ForwardReference[],
  noise: Set<string> = FALSE_POSITIVE_BASELINE,
): IngestCandidate[] {
  const out: IngestCandidate[] = [];
  const seen = new Map<string, number>();
  for (const r of refs) {
    const key = baselineKey(r);
    if (noise.has(key)) continue;
    const d = r.disposition;
    if (d?.kind === 'none' || d?.kind === 'malformed') continue;
    // Two references whose text heads coincide would be one Seed; number the repeats in file
    // order so each promise keeps its own identity. A backstop — the text is meant to differ.
    const base = `${r.file}#${anchorOf(key.slice(r.file.length + 2))}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const ref = n === 1 ? base : `${base}~${n}`;
    const body = `${r.text}\n— ${r.file}:${r.line}`;
    if (d?.kind === 'lane') out.push({ ref, body, lane_id: d.lane, kind: 'lane' });
    else if (d?.kind === 'deferred') out.push({ ref, body, kind: 'deferred' });
    else out.push({ ref, body, kind: 'undisposed' });
  }
  return out;
}
