import { defineConfig } from 'vite';

/**
 * Vite config for the OLP web UI.
 *
 * Vanilla TypeScript SPA skeleton. History-API fallback is enabled
 * so Terwo-style clean slugs (`/login`, `/dashboard`, ...) resolve
 * to `index.html` during dev and preview.
 */
export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
