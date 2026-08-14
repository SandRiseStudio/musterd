/*
 * The falsifier for tests/setup/workspace-src-aliases.ts (ADR 267).
 *
 * Each pair imports the same package once by its published name and once by its source path. If the
 * alias holds, both specifiers resolve to the SAME module instance and the namespaces are identical.
 * If the alias is ever dropped or broken, the name-import falls back through package.json `exports`
 * to gitignored dist/ — a different module — and this fails loudly instead of letting the suite
 * silently test stale build output again (four incidents in two days before this existed).
 */
import { describe, expect, it } from 'vitest';
import * as mcpViaName from '@musterd/mcp';
import * as protocolViaName from '@musterd/protocol';
import * as buildStampViaName from '@musterd/protocol/build-stamp';
import * as projectViaName from '@musterd/protocol/project';
import * as serverViaName from '@musterd/server';
import * as telemetryViaName from '@musterd/telemetry';
import * as mcpViaSrc from '../packages/mcp/src/index.ts';
import * as buildStampViaSrc from '../packages/protocol/src/build-stamp.ts';
import * as protocolViaSrc from '../packages/protocol/src/index.ts';
import * as projectViaSrc from '../packages/protocol/src/project.ts';
import * as serverViaSrc from '../packages/server/src/index.ts';
import * as telemetryViaSrc from '../packages/telemetry/src/index.ts';

describe('workspace imports resolve to src, not dist', () => {
  it.each([
    ['@musterd/protocol', protocolViaName, protocolViaSrc],
    ['@musterd/protocol/project', projectViaName, projectViaSrc],
    ['@musterd/protocol/build-stamp', buildStampViaName, buildStampViaSrc],
    ['@musterd/server', serverViaName, serverViaSrc],
    ['@musterd/mcp', mcpViaName, mcpViaSrc],
    ['@musterd/telemetry', telemetryViaName, telemetryViaSrc],
  ])('%s is the same module as its source file', (_name, viaName, viaSrc) => {
    expect(viaName).toBe(viaSrc);
  });
});
