import type { Environment } from '@olp/env-core';
import type { SysDeps } from '@olp/sysinfo';
import { createMonitorSampler, sampleProcesses, sampleSummary } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';

/** Inputs for {@link registerMonitorRoutes}. */
export interface MonitorOptions {
  env: Environment;
  deps: SysDeps;
  /** Directory the disk probe measures (file-manager root). */
  root: string;
}

/**
 * Register the monitor endpoints (wave 1, read-only). The sampler lives
 * in this closure (per server instance, injected deps — never a module
 * global), so CPU/rate fields resolve from the second poll on. Both
 * routes sit behind the session gate (registered after auth routes).
 * Process kill is deliberately absent (deferred authz-designed wave).
 */
export function registerMonitorRoutes(app: FastifyInstance, opts: MonitorOptions): void {
  const sampler = createMonitorSampler();

  app.get('/api/monitor/summary', async () => sampleSummary(opts.env, opts.deps, sampler, opts.root));

  app.get('/api/monitor/processes', async (req) => {
    const raw = (req.query as { limit?: unknown } | undefined)?.limit;
    const limit = typeof raw === 'string' ? Number.parseInt(raw, 10) : 25;
    return sampleProcesses(opts.deps, sampler, Number.isInteger(limit) ? limit : 25);
  });
}
