import * as http from 'node:http';

/** Site row the watchdog evaluates (liveness from the shared runtime). */
export interface WatchedSite {
  id: string;
  name: string;
  port: number;
  running: boolean;
}

/**
 * Liveness probe: resolves when the site answers, rejects on
 * timeout/refusal. Failures are DOWN signals, never exceptions.
 */
export interface WatchdogProbe {
  check(port: number): Promise<void>;
}

/** Inputs for {@link createWatchdog} (all injected; no timers inside). */
export interface WatchdogOptions {
  sites: () => WatchedSite[];
  probe: WatchdogProbe;
  notify: (text: string) => void;
}

/** Poller core (lifecycle stays server-owned). */
export interface Watchdog {
  /** Evaluate every running site once; never rejects. */
  checkOnce(): Promise<void>;
  /** Currently down-marked site count. */
  readonly downCount: number;
}

/** Production probe: `GET http://127.0.0.1:<port>/` with timeout. */
export function nodeProbe(timeoutMs = 5000): WatchdogProbe {
  return {
    check: (port) =>
      new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
          res.resume();
          resolve();
        });
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.on('error', (err) => reject(err));
      }),
  };
}

/**
 * Create the watchdog. DOWN/recovered notify exactly on transitions;
 * stopped sites drop state silently; `checkOnce` never rejects
 * (Terwo `healthCheckOnce` parity).
 */
export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const down = new Set<string>();
  return {
    get downCount() {
      return down.size;
    },
    checkOnce: async () => {
      for (const site of opts.sites()) {
        if (!site.running) {
          down.delete(site.id);
          continue;
        }
        try {
          await opts.probe.check(site.port);
          if (down.has(site.id)) {
            down.delete(site.id);
            opts.notify(`Website "${site.name}" recovered (port ${site.port})`);
          }
        } catch {
          if (!down.has(site.id)) {
            down.add(site.id);
            opts.notify(`Website "${site.name}" DOWN (port ${site.port})`);
          }
        }
      }
    },
  };
}
