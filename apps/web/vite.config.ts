import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Vite config for the OLP web UI (React + Tailwind v4).
 *
 * History-API fallback is enabled so Terwo-style clean slugs (`/login`,
 * `/dashboard`, ...) resolve to `index.html` during dev and preview.
 */
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/term': { target: 'ws://127.0.0.1:8080', ws: true },
    },
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
