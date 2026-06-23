/**
 * A *minimal* TOML helper scoped strictly to Codex's `[mcp_servers.<name>]` tables (ADR 031). It is
 * deliberately **not** a general TOML parser — musterd hand-edits only its own MCP-server tables and
 * passes everything else in `.codex/config.toml` through verbatim, so a new TOML runtime dependency
 * (hard rule #6) is avoided and the user's other Codex settings are never reformatted or lost.
 *
 * The model: a config file is a sequence of *sections*. A section begins at a table header line
 * (`[...]`) and runs until the next header or EOF. We only ever add/remove the sections whose header
 * is exactly `[mcp_servers.<name>]` or `[mcp_servers.<name>.env]`; every other section is preserved
 * byte-for-byte. We always *write* a server as a header table + an `.env` subtable, so our own output
 * is predictable and round-trips through {@link removeServers}.
 */

export interface CodexServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** TOML basic-string quoting: escape backslash and double-quote, wrap in quotes. */
function str(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** A bare key if it matches TOML's bare-key grammar, else a quoted key. */
function key(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : str(k);
}

/** Render one server as a `[mcp_servers.<name>]` table (+ `.env` subtable when it has env). */
export function renderServer(name: string, s: CodexServer): string {
  const lines = [`[mcp_servers.${key(name)}]`, `command = ${str(s.command)}`];
  lines.push(`args = [${s.args.map(str).join(', ')}]`);
  const envKeys = Object.keys(s.env);
  if (envKeys.length > 0) {
    lines.push('', `[mcp_servers.${key(name)}.env]`);
    for (const k of envKeys) lines.push(`${key(k)} = ${str(s.env[k]!)}`);
  }
  return lines.join('\n') + '\n';
}

/** Is `[mcp_servers.<name>]` (the server itself, not just its `.env`) present in `toml`? */
export function hasServer(toml: string, name: string): boolean {
  return sectionHeaders(toml).some((h) => h === `mcp_servers.${name}`);
}

/** All MCP server names currently defined in `toml` (the `[mcp_servers.<name>]` headers). */
export function listServers(toml: string): string[] {
  const out: string[] = [];
  for (const h of sectionHeaders(toml)) {
    const m = /^mcp_servers\.([^.]+)$/.exec(h);
    if (m) out.push(unquoteKey(m[1]!));
  }
  return out;
}

/**
 * Add/replace a server: drop any existing `[mcp_servers.<name>]` (+ `.env`) sections, then append a
 * freshly rendered one. Per-server idempotency — only this name's tables change; the rest is kept.
 */
export function upsertServer(toml: string, name: string, s: CodexServer): string {
  const stripped = removeServers(toml, [name]).replace(/\s+$/, '');
  const block = renderServer(name, s); // ends with '\n'
  return stripped.length === 0 ? block : stripped + '\n\n' + block;
}

/** Remove the `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]` sections for each name. */
export function removeServers(toml: string, names: string[]): string {
  if (toml.trim().length === 0) return toml;
  const drop = new Set(names);
  const sections = splitSections(toml);
  const kept = sections.filter((sec) => {
    const h = sectionHeader(sec);
    if (h === null) return true; // preamble before any header — keep
    const m = /^mcp_servers\.([^.]+)(?:\.env)?$/.exec(h);
    return !(m && drop.has(unquoteKey(m[1]!)));
  });
  return normalizeBlankRuns(kept.join(''));
}

// --- internals -------------------------------------------------------------

/** Split into sections: a leading preamble (no header) + one chunk per `[...]` header to next header. */
function splitSections(toml: string): string[] {
  const lines = toml.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) sections.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    // A header opens a new section; flush whatever preceded it (preamble or a prior table).
    if (isHeader(line) && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return sections.map((s, i) => (i < sections.length - 1 ? s + '\n' : s));
}

function isHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/** The dotted header path of a section (e.g. `mcp_servers.foo.env`), or null if it has no header. */
function sectionHeader(section: string): string | null {
  for (const line of section.split('\n')) {
    const m = /^\s*\[([^[\]]+)\]\s*$/.exec(line);
    if (m) return m[1]!.trim();
    if (isHeader(line)) return null;
  }
  return null;
}

function sectionHeaders(toml: string): string[] {
  return splitSections(toml)
    .map(sectionHeader)
    .filter((h): h is string => h !== null);
}

function unquoteKey(k: string): string {
  return /^".*"$/.test(k) ? k.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : k;
}

/** Collapse 3+ consecutive newlines to 2 so removals don't leave big gaps. */
function normalizeBlankRuns(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}
