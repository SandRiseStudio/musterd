import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';

// Mock the CLI's own build stamp: the real cliBuild() reads this worktree's ambient
// dist/build.json, which would couple the assertions to whatever was last built here.
let stampedBuild: string | undefined;
vi.mock('./version.js', () => ({
  cliVersion: () => '0.0.0',
  cliBuild: () => stampedBuild,
}));

/** Capture the headers of the first fetch call. */
function stubOkFetch() {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function headersOf(key: string): Promise<Record<string, string>> {
  const fn = stubOkFetch();
  await new HttpClient({ server: 'http://x', key, seat: 'a', surface: 'cli' }).roster('dawn');
  return (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
}

describe('HttpClient x-musterd-build forwarding (ADR 135)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    stampedBuild = undefined;
  });

  it('forwards x-musterd-build for an agent key', async () => {
    stampedBuild = 'a'.repeat(40);
    expect((await headersOf('mskey_team'))['x-musterd-build']).toBe('a'.repeat(40));
  });

  it('forwards x-musterd-build for a HUMAN credential too — no ADR 121 gate (build attests the binary, not the actor)', async () => {
    stampedBuild = 'b'.repeat(40) + '-dirty';
    expect((await headersOf('mscr_human'))['x-musterd-build']).toBe('b'.repeat(40) + '-dirty');
  });

  it('omits the header entirely when the dist is unstamped', async () => {
    stampedBuild = undefined;
    expect((await headersOf('mskey_team'))['x-musterd-build']).toBeUndefined();
  });
});
