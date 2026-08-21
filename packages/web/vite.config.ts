import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import viteReact from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig, type Plugin } from 'vite';

// In dev, the /live dashboard talks to the daemon same-origin and Vite proxies the daemon paths
// (/teams, /ws, /health) to it — set MUSTERD_DAEMON to point at a daemon (default :4849). We strip
// the browser Origin on the way out so the daemon's ADR 040 upgrade gate sees a non-browser loopback
// client (the alternative — adding the dev origin to allowedOrigins — would need per-machine config).
// In production the daemon serves the web and these paths from one origin, so no proxy is needed.
const daemon = process.env['MUSTERD_DAEMON'] ?? 'http://127.0.0.1:4849';
// reason: vite's proxy `configure` hands us an http-proxy instance with loose types; the events are stable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripOrigin = (proxy: any) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxy.on('proxyReq', (r: any) => r.removeHeader?.('origin'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxy.on('proxyReqWs', (r: any) => r.removeHeader?.('origin'));
};
const proxyEntry = { target: daemon, changeOrigin: true, configure: stripOrigin };

/** One id for one build: the checkout's sha (what the /live publisher stamps as `.published-sha`),
 * or a timestamp outside a checkout. Baked into the bundle as `__WEB_BUILD__` AND written to
 * `build.json` beside index.html — buildSync.ts compares the two so a long-lived page (the broadcast
 * machine's Chrome above all) reloads itself once onto the build the daemon serves. */
function buildId(): string {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  // Outside a checkout the timestamp still changes every build, which is all convergence needs.
  return /^[0-9a-f]{40}$/.test(sha) ? sha : `t${Date.now().toString(36)}`;
}

/** Emit `build.json` into every build output; only the client dist (the published web-root) is read. */
function buildStamp(id: string): Plugin {
  return {
    name: 'musterd-build-stamp',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: `{"build":"${id}"}\n` });
    },
  };
}

// The roadmap page is content, not an app: we prerender `/` to static HTML so the
// build output can be served by any static host (and, later, by @musterd/server).
// TanStack Start stays underneath so the future stateful dashboard adds routes without a
// framework change. This Start version doesn't inject a React plugin, so we add @vitejs/plugin-react
// ourselves (required for the dev-mode React Refresh runtime).
export default defineConfig(({ command }) => {
  // One id per `vite build` invocation, shared by the bundle define and the emitted build.json —
  // dev deliberately gets neither, so buildSync stays inert there.
  const id = command === 'build' ? buildId() : null;
  return {
  ...(id ? { define: { __WEB_BUILD__: JSON.stringify(id) } } : {}),
  // `vite dev` evaluates modules instead of bundling them, so @musterd/protocol's barrel drags
  // enforcement.ts — and its `node:crypto` import — into the browser, where Vite's externalized
  // stub throws on first access and takes /live down into its error boundary. The production build
  // tree-shakes that module out, which is why only dev broke. Alias it to a throwing stub for dev
  // only, so the prod bundle (and its ADR 151 byte budget) is bit-for-bit unchanged.
  resolve: {
    alias:
      command === 'serve'
        ? [
            {
              find: /^node:crypto$/,
              replacement: fileURLToPath(new URL('./src/dev/node-crypto-stub.ts', import.meta.url)),
            },
          ]
        : [],
  },
  server: {
    // Deliberately NOT Vite's default 5173. `:5173` used to be *the* /live viewer (a `pnpm dev` server run
    // as a LaunchAgent, ADR 124) until the daemon took over serving /live from its own origin (ADR 132).
    // Leaving dev on 5173 would let a stale bookmark quietly resolve to whatever WIP dev server happened to
    // be up — the exact "is my change live, and on which port?" confusion ADR 132 set out to kill. Pinning
    // dev to 5174 keeps 5173 dead (a stale link fails fast) and keeps the two roles unambiguous:
    //   :4849/live → THE viewer (daemon-served, production bundle, always on)
    //   :5174/live → your ephemeral WIP preview (this dev server, proxied to the daemon for data)
    port: 5174,
    proxy: {
      '/teams': proxyEntry,
      '/health': proxyEntry,
      '/ws': { ...proxyEntry, ws: true },
    },
  },
  plugins: [
    tanstackStart({
      // retryCount: the plugin's default is 0, which turns ONE transient fetch failure against the
      // crawl's own localhost server into a failed build. Under machine load (a live stream encode,
      // 2026-07-24) that killed `service refresh` mid-flight — and a transient build failure also
      // strands the auto-refresher, whose debounce skips the failed tip until the NEXT commit lands.
      // Three retries a second apart absorb a busy machine; a page that fails four times is a real
      // bug and still fails the build (failOnError stays default-true).
      prerender: { enabled: true, crawlLinks: true, retryCount: 3, retryDelay: 1000 },
      // The ADR 300 public set's static roots; the slug pages (/docs/<slug>, /blog/<slug>) are
      // discovered by crawlLinks from exactly the index pages' <a> lists.
      pages: [{ path: '/' }, { path: '/roadmap' }, { path: '/docs' }, { path: '/blog' }],
    }),
    viteReact(),
    ...(id ? [buildStamp(id)] : []),
  ],
  };
});
