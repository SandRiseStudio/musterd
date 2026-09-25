import { TOKEN_PREFIXES, type TokenKind } from './credentials.js';

/**
 * The credential scrub (ADR 445 §3, increment 1b) — hard rule 5 ("never log secrets") applied to the
 * trace store's content column. Tool inputs and outputs carry secrets verbatim (a `cat` of a
 * binding, a token in a curl header), so every content string is scrubbed **at the hook, before it
 * leaves the process**, and again at ingest, before it is stored. Two passes with one function:
 * the hook's pass is the one that matters, the daemon's is the net under an older or foreign tap.
 *
 * A **credential** scrub only. It is not a PII scrubber — ADR 184 §2 rejects that as false safety —
 * so prose stays prose, emails stay emails, and a git SHA stays a SHA. What it replaces:
 *
 * - every musterd token, driven by the {@link TOKEN_PREFIXES} registry, so a prefix registered there
 *   later is scrubbed without touching this file (`<redacted:agent_key>`, `<redacted:grant>`, …);
 * - the generic shapes: PEM private-key blocks, `Bearer …` / `Basic …` authorization values,
 *   `sk-…` (OpenAI / Anthropic), GitHub tokens (`ghp_…`, `github_pat_…`), AWS access key ids,
 *   Slack tokens, and a 32+-char key-ish run assigned to a name that says token / key / secret /
 *   password (`API_KEY=…`, `"access_token": "…"`).
 *
 * Every replacement is `<redacted:kind>` and is counted, so a row says how many it lost.
 */

/** The marker a scrubbed value becomes. Deliberately short and made of characters no rule below
 *  matches as a secret, so a second pass over scrubbed text is a no-op. */
export function redactionMarker(kind: string): string {
  return `<redacted:${kind}>`;
}

interface ScrubRule {
  kind: string;
  re: RegExp;
  /** Replace only part of the match (keep a header name or an assignment's key). Default: all. */
  replace?: (match: string, ...groups: string[]) => string;
}

/** A character that can continue a token. A prefix preceded by one is inside a longer word. */
const TOKEN_BODY = 'A-Za-z0-9_\\-';

/**
 * Where a credential may start: not inside a longer word — UNLESS the "word" is an escape. Content
 * reaches the scrub as JSON text (a tool response object, stringified) and as URL-encoded query
 * strings, so a token that followed a newline arrives as `\nmskey_…`, and one after a quote as
 * `%22mskey_…` or `\u0022mskey_…`; a plain word-boundary test reads the `n` / `2` as part of a word
 * and lets the token through. Measured building this corpus, not hypothetical.
 */
const START = `(?:(?<![${TOKEN_BODY}])|(?<=\\\\[nrtbf])|(?<=%[0-9A-Fa-f]{2})|(?<=\\\\u[0-9A-Fa-f]{4}))`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One rule per registered musterd prefix, longest first so a longer prefix never loses to a
 *  shorter one that happens to be its own prefix. */
function musterdRules(): ScrubRule[] {
  return (Object.entries(TOKEN_PREFIXES) as [TokenKind, string][])
    .sort((a, b) => b[1].length - a[1].length)
    .map(([kind, prefix]) => ({
      kind,
      // The body is at least 8 characters: `mskey_` alone in prose ("the mskey_ prefix") is a
      // mention of the namespace, not a credential, and a real token is far longer.
      // No start boundary, deliberately: a musterd prefix is specific enough that one inside a
      // longer run (`xmskey_…`, a token pasted onto a word) is still a token, and a miss here
      // stores a secret while a false hit costs one identifier its tail.
      re: new RegExp(`${escapeRe(prefix)}[${TOKEN_BODY}]{8,}`, 'gi'),
    }));
}

/**
 * The generic shapes. A value class never admits `<` or `>`, so a marker a previous rule (or the
 * previous pass) wrote is never matched again — the scrub is idempotent and never double-counts.
 */
const GENERIC_RULES: readonly ScrubRule[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    // An `Authorization` header or field, whatever its scheme: the header name and scheme stay, so
    // the row still says what kind of auth the call used; the credential goes.
    kind: 'authorization',
    re: new RegExp(
      `${START}(Authorization["']?\\s*[:=]\\s*["']?(?:(?:Bearer|Basic|Token|Digest)\\s+)?)([^\\s"',;<>\\\\]{8,})`,
      'gi',
    ),
    replace: (_m, head) => `${head}${redactionMarker('authorization')}`,
  },
  {
    // A bare `Bearer x` outside a header (a curl in prose, a log line). Requires a digit or a token
    // symbol in the value, so "Bearer authentication" in a sentence is not a credential.
    kind: 'bearer',
    re: new RegExp(
      `${START}(Bearer\\s+)(?=[A-Za-z0-9._~+/-]*[0-9._~+/-])([A-Za-z0-9._~+/-]{16,}=*)`,
      'g',
    ),
    replace: (_m, head) => `${head}${redactionMarker('bearer')}`,
  },
  { kind: 'sk', re: new RegExp(`${START}sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}`, 'g') },
  {
    kind: 'github',
    re: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'),
  },
  { kind: 'aws', re: new RegExp(`${START}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])`, 'g') },
  { kind: 'slack', re: new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g') },
  {
    // `API_KEY=…`, `token: …`, `"client_secret": "…"`, `--password=…`. The NAME decides it, so a
    // 40-hex git SHA on its own is left alone and a 32+-char run assigned to such a name is not. A
    // value that starts like a path (`/`, `./`, `~`) is a path, not a key.
    kind: 'assignment',
    re: new RegExp(
      `${START}([A-Za-z0-9_.-]*(?:token|key|secret|password|passwd|credential)s?)(["']?\\s*[:=]\\s*["']?)(?![./~])([A-Za-z0-9+/_.=-]{32,})`,
      'gi',
    ),
    replace: (_m, name, sep) => `${name}${sep}${redactionMarker('assignment')}`,
  },
];

let cachedRules: ScrubRule[] | undefined;

/** The rules in application order: whole blocks, then headers, then the registry, then the rest.
 *  Headers go before the registry so `Authorization: Bearer mskey_…` counts once, as a header. */
function rules(): ScrubRule[] {
  cachedRules ??= [
    GENERIC_RULES[0]!,
    GENERIC_RULES[1]!,
    ...musterdRules(),
    ...GENERIC_RULES.slice(2),
  ];
  return cachedRules;
}

export interface ScrubResult {
  text: string;
  /** How many credentials were replaced. */
  redactions: number;
}

/**
 * Scrub every string leaf of a structured value (a tool's input object, a response with `stdout`)
 * and return it as JSON text. Scrubbing the leaves BEFORE stringifying is the stronger of the two
 * passes: the scrub sees real newlines and quotes, not their escapes. Strings pass straight through.
 */
export function scrubToText(value: unknown): ScrubResult {
  if (typeof value === 'string') return scrubCredentials(value);
  let redactions = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = scrubCredentials(v);
      redactions += r.redactions;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const walked = walk(value);
  // …and once more over the JSON text, for a key/value pair the leaf pass could not see whole
  // (`{"api_key": "<long value>"}` is a secret only as a pair). Idempotent, so nothing counts twice.
  const final = scrubCredentials(JSON.stringify(walked) ?? '');
  return { text: final.text, redactions: redactions + final.redactions };
}

/** Replace every credential in `text` with its `<redacted:kind>` marker. Pure; never throws. */
export function scrubCredentials(text: string): ScrubResult {
  let out = text;
  let redactions = 0;
  for (const rule of rules()) {
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      redactions++;
      // `rest` is (...groups, offset, input) — no named groups are used, so the last two go.
      const groups = rest.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''));
      return rule.replace ? rule.replace(match, ...groups) : redactionMarker(rule.kind);
    });
  }
  return { text: out, redactions };
}
