import type { Environment, ServiceManId } from '@olp/env-core';
import type { SysDeps } from '@olp/sysinfo';
import { scanDaemons } from '@olp/sysinfo';
import type { InitSystem, ServiceController } from '@olp/services';
import { serviceController } from '@olp/services';
import type { FastifyInstance } from 'fastify';

/** Inputs for {@link registerServicesRoutes}. */
export interface ServicesOptions {
  env: Environment;
  deps: SysDeps;
  /** Controller factory override (tests pass fakes; production uses `serviceController`). */
  controllerOf?: ServicesControllerOf;
}

/** Controller factory shape (mirrors `serviceController`). */
export type ServicesControllerOf = (manager: InitSystem, exec: SysDeps['exec']) => ServiceController;

/** Static presentation facts (labels/ports are not probes). */
const DAEMONS = [
  { id: 'mariadb', name: 'MariaDB', port: 3306 as number | null, unit: 'mariadb' },
  { id: 'postgres', name: 'PostgreSQL', port: 5432 as number | null, unit: 'postgresql' },
  { id: 'redis', name: 'Redis', port: 6379 as number | null, unit: 'redis-server' },
  { id: 'cronie', name: 'Cronie', port: null, unit: 'cron' },
] as const;

/** env-core manager → services-controller manager (unknown → `none`). */
function toInitSystem(service: ServiceManId): InitSystem {
  switch (service) {
    case 'pm2':
    case 'systemd':
    case 'openrc':
    case 'launchd':
      return service;
    default:
      return 'none';
  }
}

/**
 * Register the daemon status + control endpoints (wave 3). Status is
 * process presence (never guessed unit states); START reuses the
 * `services` controller and surfaces its honest errors. Both routes
 * sit behind the session gate. No STOP endpoint (mockup shows START
 * only — recorded).
 */
export function registerServicesRoutes(app: FastifyInstance, opts: ServicesOptions): void {
  const buildController = opts.controllerOf ?? ((manager, exec) => serviceController(manager, exec));

  app.get('/api/services', async () => {
    const presence = scanDaemons(opts.deps);
    return {
      services: DAEMONS.map((d) => ({
        id: d.id,
        name: d.name,
        port: d.port,
        active: presence[d.id] === true,
      })),
    };
  });

  app.post('/api/services/:id/start', async (req, reply) => {
    const id = (req.params as { id?: unknown }).id;
    const daemon = DAEMONS.find((d) => d.id === id);
    if (daemon === undefined) {
      reply.code(404);
      return { error: 'Unknown service' };
    }
    let controller: ServiceController;
    try {
      controller = buildController(toInitSystem(opts.env.service), opts.deps.exec);
    } catch {
      reply.code(500);
      return { error: 'No supported init system detected' };
    }
    try {
      await controller.start(daemon.unit);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      const message = err instanceof Error ? err.message : String(err);
      return { error: message.slice(0, 300) };
    }
  });
}
