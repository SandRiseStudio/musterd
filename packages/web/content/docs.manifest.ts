/**
 * The ONLY repo files that reach the public /docs section (ADR 300). Entries resolve relative to
 * the REPO ROOT. An explicit list, never a glob: repo docs are written for the team, and each
 * line here is a deliberate publish decision. `gen-site-content.ts` fails the build if a source
 * is missing. `title: null` lifts the title from the file's first `# ` heading.
 */
export interface DocEntry {
  slug: string;
  title: string | null;
  source: string;
}

export const DOCS_MANIFEST: DocEntry[] = [
  { slug: 'getting-started', title: null, source: 'packages/web/content/docs/getting-started.md' },
  { slug: 'concepts', title: null, source: 'packages/web/content/docs/concepts.md' },
  // The protocol spec is designed in the open (MIT, versioned from the first commit) — the one
  // team file that is already written for outside readers.
  { slug: 'spec', title: 'Protocol spec', source: 'SPEC.md' },
];
