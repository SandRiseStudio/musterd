/**
 * The host identity supplied in MCP initialize. This is diagnostic harness context, deliberately
 * distinct from a model declaration: client identity must never influence model attestation.
 */
export interface HarnessContext {
  name: string;
  version?: string;
}

/** The narrow MCP SDK seam used after initialization completes. */
export interface ClientVersionSource {
  getClientVersion(): { name: string; version?: string } | undefined;
}

/** The SDK invokes this hook after it has stored the client's initialize `clientInfo`. */
export interface InitializeObservable extends ClientVersionSource {
  oninitialized?: () => void;
}

const MAX_HARNESS_FIELD_LENGTH = 120;
const ANSI_CSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function sanitize(value: string | undefined): string | undefined {
  const trimmed = value
    ?.replace(ANSI_CSI_SEQUENCE, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  return trimmed ? trimmed.slice(0, MAX_HARNESS_FIELD_LENGTH) : undefined;
}

/** Capture the initialized MCP client's identity as bounded, adapter-local diagnostic context. */
export function captureHarnessContext(source: ClientVersionSource): HarnessContext | undefined {
  const client = source.getClientVersion();
  if (!client) return undefined;
  const name = sanitize(client.name);
  if (!name) return undefined;
  const version = sanitize(client.version);
  return version ? { name, version } : { name };
}

/** Run `onCapture` once MCP initialization has completed and the SDK exposes the host identity.
 * Legacy-handshake clients only: the stateless 2026-07-28 protocol never sends `initialize`, so
 * this hook never fires there — {@link observeHarnessRequests} is the modern-era capture. */
export function observeHarnessInitialization(
  source: InitializeObservable,
  onCapture: (context: HarnessContext | undefined) => void,
): void {
  const previous = source.oninitialized;
  source.oninitialized = () => {
    previous?.();
    onCapture(captureHarnessContext(source));
  };
}

/** The spec's `_meta` key clientInfo travels under on every 2026-07-28 request (ADR 175 step 5). */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** A per-request `_meta` clientInfo value → bounded harness context. Pure; reuses the same
 * `sanitize` bounds as the initialize-time capture so both eras land identically. */
export function harnessFromClientInfo(info: unknown): HarnessContext | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const { name, version } = info as { name?: unknown; version?: unknown };
  const cleanName = sanitize(typeof name === 'string' ? name : undefined);
  if (!cleanName) return undefined;
  const cleanVersion = sanitize(typeof version === 'string' ? version : undefined);
  return cleanVersion ? { name: cleanName, version: cleanVersion } : { name: cleanName };
}

/** The modern-era capture (ADR 120 under MCP spec 2026-07-28): clientInfo rides `_meta` on every
 * request, so read it at the tools/call seam — the same setRequestHandler patch shape as the
 * telemetry/repair/coercion siblings, defensive the same way. First capture wins and the observer
 * goes quiet (memoized once per process, matching the one-shot `oninitialized` semantics); the
 * SDK's per-request-backfilled `getClientVersion()` is the fallback read when `_meta` carries
 * nothing this wrapper can use. Both eras stay wired: a legacy client fires
 * {@link observeHarnessInitialization} instead, and whichever seam captures first wins. */
export function observeHarnessRequests(
  inner: { setRequestHandler: (...args: unknown[]) => unknown } & Partial<ClientVersionSource>,
  onCapture: (context: HarnessContext) => void,
): void {
  let captured = false;
  const original = inner.setRequestHandler.bind(inner) as (...args: unknown[]) => unknown;
  inner.setRequestHandler = (...args: unknown[]) => {
    const method = args[0];
    const handler = args[args.length - 1] as (request: unknown, ctx: unknown) => unknown;
    if (method !== 'tools/call' || typeof handler !== 'function') return original(...args);
    const wrapped = (request: unknown, ctx: unknown): unknown => {
      if (!captured) {
        const meta = (request as { params?: { _meta?: Record<string, unknown> } } | undefined)
          ?.params?._meta;
        const context =
          harnessFromClientInfo(meta?.[CLIENT_INFO_META_KEY]) ??
          (inner.getClientVersion
            ? captureHarnessContext(inner as ClientVersionSource)
            : undefined);
        if (context) {
          captured = true;
          onCapture(context);
        }
      }
      return handler(request, ctx);
    };
    return original(...args.slice(0, -1), wrapped);
  };
}
