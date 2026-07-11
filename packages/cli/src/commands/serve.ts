import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { createServer } from '@musterd/server';
import { flagStr, type Parsed } from '../args.js';
import { renderBanner } from '../render/rows.js';
import { theme } from '../render/theme.js';

/**
 * The commit this daemon boots from (ADR 130), resolved once from the CLI's own checkout — the same
 * repo-root derivation `service refresh` syncs (`…/packages/cli/dist/bin.js` → up four). Best-effort:
 * an npm-installed CLI has no checkout and the daemon simply omits `build` from `/health`.
 */
function resolveBuildRef(): string | undefined {
  const repoRoot = resolvePath(process.argv[1] ?? '', '../../../..');
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const ref = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(ref) ? ref : undefined;
}

/**
 * Launch the daemon in the foreground. This is the one place the CLI imports
 * @musterd/server (ADR 002); every other command talks over the wire.
 */
export async function serveCommand(parsed: Parsed): Promise<number> {
  const portFlag = flagStr(parsed.flags, 'port');
  const host = flagStr(parsed.flags, 'host');
  const tlsCert = flagStr(parsed.flags, 'tls-cert');
  const tlsKey = flagStr(parsed.flags, 'tls-key');
  const trustProxy = parsed.flags['insecure-trust-proxy'] === true;
  // Serve a built web UI same-origin (ADR 062) — flag or MUSTERD_WEB_ROOT.
  const webRoot = flagStr(parsed.flags, 'web-root') ?? process.env['MUSTERD_WEB_ROOT'];
  const buildRef = resolveBuildRef();
  const server = createServer({
    ...(portFlag ? { port: Number(portFlag) } : {}),
    ...(host ? { host } : {}),
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    ...(trustProxy ? { trustProxy: true } : {}),
    ...(webRoot ? { webRoot } : {}),
    ...(buildRef ? { buildRef } : {}),
  });
  const { port, host: boundHost } = await server.listen();

  process.stdout.write(renderBanner() + '\n\n');
  process.stdout.write(
    `${theme.ok('●')} listening on ${theme.accent(`${server.scheme}://${boundHost}:${port}`)}\n`,
  );
  // Make exposure answerable (ADR 016/040): say plainly when a non-loopback bind is trusting a proxy.
  if (trustProxy) {
    process.stdout.write(
      theme.meta('  trusting a TLS-terminating proxy/overlay in front (--insecure-trust-proxy)') +
        '\n',
    );
  }
  // Show which db is live — a daemon silently serving the wrong db reads as "everyone offline".
  process.stdout.write(theme.meta(`  db: ${server.dbPath}`) + '\n');
  if (webRoot) {
    process.stdout.write(
      theme.meta(
        `  serving web UI from ${webRoot} (open ${server.scheme === 'wss' ? 'https' : 'http'}://${boundHost}:${port}/live)`,
      ) + '\n',
    );
  }
  process.stdout.write(theme.meta('ctrl-c to stop') + '\n');

  // SIGHUP reloads the durable roster (ADR 058): re-resolve roots + reconcile, so a team exported
  // after the daemon started is picked up without a restart.
  process.on('SIGHUP', () => {
    server.reload();
    process.stdout.write(theme.meta('reloaded roster roots (SIGHUP)') + '\n');
  });
  await new Promise<void>((resolveP) => {
    process.on('SIGINT', () => {
      void server.close().then(() => resolveP());
    });
  });
  return 0;
}
