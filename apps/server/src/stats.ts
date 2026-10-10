import * as fs from 'node:fs';
import * as os from 'node:os';
import type { Environment } from '@olp/env-core';
import { getSystemInfo } from '@olp/sysinfo';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';

/**
 * Build production host dependencies from node builtins.
 * Test code injects fakes instead (see `test/stats-routes.test.ts`).
 */
export function nodeDeps(): SysDeps {
  return {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    hostname: () => os.hostname(),
    uptime: () => os.uptime(),
    exec: defaultExec,
    readDir: (dir) => fs.readdirSync(dir),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

/** Inputs for {@link registerStatsRoutes}. */
export interface StatsOptions {
  env: Environment;
  deps: SysDeps;
  /** Directory the disk probe measures (file-manager root). */
  root: string;
}

/**
 * Register the dashboard endpoint. Protected by the session gate
 * (registered after auth routes, so the gate hook applies).
 */
export function registerStatsRoutes(app: FastifyInstance, opts: StatsOptions): void {
  app.get('/api/stats', async () => getSystemInfo(opts.env, opts.deps, opts.root));
}
