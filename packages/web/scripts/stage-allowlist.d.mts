/**
 * Types for the plain-JS allowlist.
 *
 * `stage-allowlist.mjs` is .mjs because `stage-site.mjs` runs it directly at stage time with no
 * build step. Tests under `scripts/` import it happily, but a test under `src/` is inside the
 * app's tsconfig, where an untyped .mjs import is a TS7016 error — so the module that decides
 * what reaches the public origin could only be asserted from one half of the tree. Declaring it
 * costs six lines and lets the /watch-is-public case live beside the other route facts.
 */
export declare const PUBLIC_ALLOW: string[];
export declare const DAEMON_ROUTES: string[];
