import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createAuthContext, registerAuthRoutes, resolveDirs } from './auth.js';
import type { AuthContext } from './auth.js';

/** Configured server plus its auth state (routes mutate `auth`). */
export interface ServerHandle {
  app: FastifyInstance;
  auth: AuthContext;
}

/**
 * Create and configure the OLP API server.
 *
 * Public probes (`/healthz`, `/api/health`, `POST /api/login`) bypass
 * auth; every other `/api/*` route requires a valid `tpsid` session.
 * Pass explicit dirs in tests to avoid touching the real home directory.
 */
export function buildServer(dirs?: { dataDir?: string; legacyDir?: string }): ServerHandle {
  const resolved = resolveDirs();
  const dataDir = dirs?.dataDir ?? resolved.dataDir;
  const legacyDir = dirs?.legacyDir ?? resolved.legacyDir;
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, service: 'olp' }));
  app.get('/api/health', async () => ({
    ok: true,
    service: 'olp',
    version: '2.0.0-alpha.0',
  }));

  const auth = createAuthContext(dataDir, legacyDir);
  registerAuthRoutes(app, auth);
  return { app, auth };
}

/**
 * Start the server when executed directly (`node dist/index.js`).
 * Respects `PANEL_PORT` / `PANEL_HOST` for Terwo compat; defaults
 * to localhost-only per security posture.
 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env['PANEL_PORT'] ?? '8080', 10);
  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const { app, auth } = buildServer();
  if (auth.created && auth.plaintextPassword !== undefined) {
    // eslint-disable-next-line no-console
    console.log(
      `OLP first run — credentials (shown once):\n  username: ${auth.config.username}\n  password: ${auth.plaintextPassword}`,
    );
  }
  setInterval(() => {
    auth.store.prune();
  }, 3600 * 1000).unref();
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`OLP listening on http://${host}:${port}`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
