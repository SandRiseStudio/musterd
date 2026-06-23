import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

// The roadmap page is content, not an app: we prerender `/` to static HTML so the
// build output can be served by any static host (and, later, by @musterd/server).
// TanStack Start stays underneath so the future stateful dashboard adds routes
// without a framework change. tanstackStart() injects its own React plugin, so we
// don't add @vitejs/plugin-react ourselves; vite-plugin-glsl handles `.glsl` imports.
export default defineConfig({
  plugins: [
    glsl(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [{ path: '/' }],
    }),
  ],
});
