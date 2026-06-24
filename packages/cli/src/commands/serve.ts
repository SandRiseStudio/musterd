import { createServer } from '@musterd/server';
import { flagStr, type Parsed } from '../args.js';
import { renderBanner } from '../render/rows.js';
import { theme } from '../render/theme.js';

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
  const server = createServer({
    ...(portFlag ? { port: Number(portFlag) } : {}),
    ...(host ? { host } : {}),
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    ...(trustProxy ? { trustProxy: true } : {}),
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
  process.stdout.write(theme.meta('ctrl-c to stop') + '\n');

  await new Promise<void>((resolveP) => {
    process.on('SIGINT', () => {
      void server.close().then(() => resolveP());
    });
  });
  return 0;
}
