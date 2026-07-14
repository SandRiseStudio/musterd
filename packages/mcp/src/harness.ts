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

function sanitize(value: string | undefined): string | undefined {
  const trimmed = value
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
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

/** Run `onCapture` once MCP initialization has completed and the SDK exposes the host identity. */
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
