import viteReact from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

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

// The roadmap page is content, not an app: we prerender `/` to static HTML so the
// build output can be served by any static host (and, later, by @musterd/server).
// TanStack Start stays underneath so the future stateful dashboard adds routes without a
// framework change. This Start version doesn't inject a React plugin, so we add @vitejs/plugin-react
// ourselves (required for the dev-mode React Refresh runtime).
export default defineConfig({
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
      prerender: { enabled: true, crawlLinks: true },
      pages: [{ path: '/' }],
    }),
    viteReact(),
  ],
});
