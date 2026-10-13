import type { FastifyInstance } from 'fastify';

/** Log severity (closed set — the feed list is fixed, no free-form levels). */
export type LogLevel = 'info' | 'warn' | 'error';

/** One ring line (JSON-safe; never carries secrets — see spec §7). */
export interface LogLine {
  t: number;
  level: LogLevel;
  msg: string;
}

/** Feed function (routes call it; tests inject fakes). */
export type LogFeed = (level: LogLevel, msg: string) => void;

/** Ring capacity (documented; dashboard tails a slice of it). */
export const LOG_CAP = 200;
/** Default tail (documented). */
export const LOG_DEFAULT_TAIL = 50;

/** In-memory log ring (pure: append/read/clamp testable without a server). */
export interface LogRing {
  append(level: LogLevel, msg: string, at?: number): void;
  list(tail?: number): LogLine[];
}

/** Fresh ring (oldest evicted past the cap, newest last). */
export function createLogRing(cap: number = LOG_CAP): LogRing {
  const lines: LogLine[] = [];
  return {
    append: (level, msg, at = Date.now()) => {
      lines.push({ t: at, level, msg });
      while (lines.length > cap) lines.shift();
    },
    list: (tail = LOG_DEFAULT_TAIL) => {
      const n = Number.isInteger(tail) ? Math.min(Math.max(tail, 1), LOG_CAP) : LOG_DEFAULT_TAIL;
      return lines.slice(-n);
    },
  };
}

/** Register the log-tail endpoint (behind the session gate like all `/api/*`). */
export function registerLogRoutes(app: FastifyInstance, ring: LogRing): void {
  app.get('/api/logs', async (req) => {
    const raw = ((req.query ?? {}) as Record<string, unknown>)['tail'];
    const tail = typeof raw === 'string' ? Number.parseInt(raw, 10) : LOG_DEFAULT_TAIL;
    return { logs: ring.list(Number.isInteger(tail) ? tail : LOG_DEFAULT_TAIL) };
  });
}
