import viteReact from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

// The roadmap page is content, not an app: we prerender `/` to static HTML so the
// build output can be served by any static host (and, later, by @musterd/server).
// TanStack Start stays underneath so the future stateful dashboard adds routes without a
// framework change. This Start version doesn't inject a React plugin, so we add @vitejs/plugin-react
// ourselves (required for the dev-mode React Refresh runtime); vite-plugin-glsl composes cleanly.
export default defineConfig({
  plugins: [
    glsl(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [{ path: '/' }],
    }),
    viteReact(),
  ],
});
