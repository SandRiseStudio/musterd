import { createRequire } from 'node:module';

/**
 * The adapter's own package version, read from `package.json` at load so MCP `serverInfo.version`
 * can never drift from the published package (ADR 175 — a hardcoded literal sat at 0.2.0 while the
 * package shipped 0.3.1). Resolved relative to this module, which works identically from `src/`
 * under vitest and from `dist/` in the tarball — `package.json` is one level up in both. Degrades
 * to '0.0.0' rather than throw: version reporting is observability, and observability never
 * crashes the adapter (the ADR 135 posture).
 */
export const ADAPTER_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
