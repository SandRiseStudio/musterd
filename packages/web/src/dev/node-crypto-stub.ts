// Dev-only stand-in for `node:crypto`, aliased in by vite.config.ts when `vite dev` runs.
//
// Why it exists: `@musterd/protocol`'s barrel re-exports enforcement.ts, whose first line is
// `import { createHash } from 'node:crypto'` (it backs gateFingerprint + the ask-body fingerprint —
// both daemon/CLI-side). The web imports unrelated symbols from that same barrel (askTierHolds,
// resolvePosture, the Lane types), so the whole module graph comes along. The production build
// tree-shakes enforcement.ts out entirely; `vite dev` does not bundle, so it evaluates the module,
// and Vite's `__vite-browser-external` shim throws on the very first property access — taking /live
// down into its error boundary before a single byte of the dashboard rendered.
//
// The web never calls these, so a stub is honest rather than papering over a gap: if that ever stops
// being true, the throw below names the reason instead of silently returning a wrong digest.
// Dev-only by construction, so the ADR 151 byte budget is untouched.

const nodeOnly = (name: string): never => {
  throw new Error(
    `node:crypto.${name} is not available in the browser. The web bundle should not reach ` +
      `Node-only code — this stub exists only so \`vite dev\` can evaluate @musterd/protocol's ` +
      `barrel (see packages/web/src/dev/node-crypto-stub.ts).`,
  );
};

export const createHash = (): never => nodeOnly('createHash');
export const randomUUID = (): never => nodeOnly('randomUUID');
export const randomBytes = (): never => nodeOnly('randomBytes');

export default { createHash, randomUUID, randomBytes };
