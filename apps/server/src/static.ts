import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Inputs for {@link registerStaticRoutes}. */
export interface StaticOptions {
  /** Built web UI directory (`apps/web/dist`), if present. */
  distDir?: string;
  /** Session check for the `/` landing redirect (auth store). */
  validate: (cookieHeader: string | undefined) => boolean;
}

/**
 * Resolve the web `dist` directory: explicit `OLP_WEB_DIR`, else the
 * sibling `apps/web/dist` (same relative depth from `src/` and `dist/`).
 * Returns `undefined` when nothing exists (API-only mode).
 */
export function resolveDistDir(fromUrl: string = import.meta.url): string | undefined {
  const override = process.env['OLP_WEB_DIR'];
  if (override !== undefined && override !== '') return override;
  const candidate = join(dirname(fileURLToPath(fromUrl)), '..', 'web', 'dist');
  return existsSync(candidate) && existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

/**
 * Serve the built SPA + landing redirect. `/` sends authed browsers to
 * `/dashboard`, others to `/login` (Terwo `/` parity). Unknown non-API
 * paths fall back to `index.html` (client-side slugs); unknown `/api/*`
 * paths keep JSON 404s. Missing `distDir` leaves the API untouched.
 */
export function registerStaticRoutes(app: FastifyInstance, opts: StaticOptions): void {
  app.get('/', async (req, reply) => {
    const authed = opts.validate(req.headers.cookie);
    reply.code(302);
    reply.header('Location', authed ? '/dashboard' : '/login');
    await reply.send();
  });

  if (opts.distDir === undefined) return;
  const distDir = opts.distDir;
  void app.register(fastifyStatic, { root: distDir, prefix: '/', dotfiles: 'deny' });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.split('?')[0]?.startsWith('/api/') ?? false) {
      reply.code(404);
      await reply.send({ error: 'Not found' });
      return;
    }
    await reply.sendFile('index.html');
  });
}
