import { defineConfig } from 'vitest/config';

/**
 * Vitest config (test-only; build/dev stay in `vite.config.ts`).
 *
 * `testTimeout` is generous on purpose: agent boxes and Termux-class
 * hardware starve the jsdom event loop under parallel transform load
 * (transform/collect dominate wall time). Assertions are unchanged —
 * this only extends failure detection, never shortens it.
 *
 * `maxForks` is capped for the same reason: 8 parallel jsdom workers
 * (each transforming Recharts/xterm) OOM a 3–4 GB box. CI machines
 * with headroom are unaffected beyond wall time.
 */
export default defineConfig({
  test: {
    testTimeout: 60000,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 2,
      },
    },
  },
});
