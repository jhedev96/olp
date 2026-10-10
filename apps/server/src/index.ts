import Fastify from 'fastify';

/**
 * Create and configure the OLP API server.
 *
 * Skeleton only: exposes liveness probes. Domain routes
 * (auth, files, sites, etc.) land here per SPEC during Phase 3.
 *
 * @returns Configured Fastify instance (not yet listening).
 */
export function buildServer() {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, service: 'olp' }));
  app.get('/api/health', async () => ({
    ok: true,
    service: 'olp',
    version: '2.0.0-alpha.0',
  }));

  return app;
}

/**
 * Start the server when executed directly (`node dist/index.js`).
 * Respects `PANEL_PORT` / `PANEL_HOST` for Terwo compat; defaults
 * to localhost-only per security posture.
 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PANEL_PORT ?? '8080', 10);
  const host = process.env.PANEL_HOST ?? '127.0.0.1';
  const app = buildServer();
  await app.listen({ port, host });
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
