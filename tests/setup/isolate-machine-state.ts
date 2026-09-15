/**
 * Global vitest isolation for machine-wide musterd paths (ADR 190).
 *
 * ADR 162 pinned MUSTERD_CONFIG via vitest `env`, but many suites `delete` that
 * override in afterEach — leaving the worker able to write the operator's real
 * ~/.musterd for any later file that reaches configPath()/hostRegistryPath()
 * without its own pin. MUSTERD_HOST_REGISTRY was never pinned at all (#542's
 * tinypool shim incident).
 *
 * This setup file re-asserts both overrides at load, before each test, and after
 * each test (so a suite's cleanup delete cannot leave the worker unprotected).
 * Suites that need a private config still set MUSTERD_CONFIG in their own
 * beforeEach — that runs after this hook and wins for the duration of the test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'musterd-vitest-machine-'));
const CONFIG = join(root, 'config.json');
const HOST_REGISTRY = join(root, 'host-registry.json');
// ADR 328 §2: node.json holds the machine's `msnode_` credentials. Pinned here for the same reason
// as the two above, and with more at stake — an unpinned suite would write real secrets into the
// operator's ~/.musterd, and a test that enrolls would overwrite a live enrollment.
const NODE_STATE = join(root, 'node.json');

function pin(): void {
  process.env['MUSTERD_CONFIG'] = CONFIG;
  process.env['MUSTERD_HOST_REGISTRY'] = HOST_REGISTRY;
  process.env['MUSTERD_NODE_STATE'] = NODE_STATE;
}

pin();
beforeEach(pin);
afterEach(pin);
