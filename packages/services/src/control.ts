import type { InitSystem } from './types.js';

/** Managed service handle (Terwo `pgrep -x` parity: presence = running). */
export interface ServiceController {
  isActive(service: string): Promise<boolean>;
  start(service: string): Promise<void>;
  stop(service: string): Promise<void>;
}

function tail(text: string): string {
  return text.slice(-500);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shell runner (defaultExec-compatible). */
export type ControlExec = (cmd: string, timeoutMs: number) => Promise<string>;

function systemd(exec: ControlExec): ServiceController {
  return {
    isActive: async (service) => {
      try {
        await exec(`systemctl is-active --quiet ${service}`, 5000);
        return true;
      } catch {
        return false;
      }
    },
    start: async (service) => {
      try {
        await exec(`systemctl start ${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to start ${service}: ${tail(errText(err))}`);
      }
    },
    stop: async (service) => {
      try {
        await exec(`systemctl stop ${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to stop ${service}: ${tail(errText(err))}`);
      }
    },
  };
}

function openrc(exec: ControlExec): ServiceController {
  const status = async (service: string): Promise<boolean> => {
    try {
      await exec(`rc-service ${service} status`, 5000);
      return true;
    } catch {
      return false;
    }
  };
  return {
    isActive: status,
    start: async (service) => {
      try {
        await exec(`rc-service ${service} start`, 15000);
      } catch (err) {
        throw new Error(`Failed to start ${service}: ${tail(errText(err))}`);
      }
    },
    stop: async (service) => {
      try {
        await exec(`rc-service ${service} stop`, 15000);
      } catch (err) {
        throw new Error(`Failed to stop ${service}: ${tail(errText(err))}`);
      }
    },
  };
}

function launchd(exec: ControlExec): ServiceController {
  return {
    isActive: async (service) => {
      try {
        await exec(`launchctl print gui/$(id -u)/${service}`, 5000);
        return true;
      } catch {
        return false;
      }
    },
    start: async (service) => {
      try {
        await exec(`launchctl kickstart -k gui/$(id -u)/${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to start ${service}: ${tail(errText(err))}`);
      }
    },
    stop: async (service) => {
      try {
        await exec(`launchctl bootout gui/$(id -u)/${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to stop ${service}: ${tail(errText(err))}`);
      }
    },
  };
}

function pm2(exec: ControlExec): ServiceController {
  return {
    isActive: async (service) => {
      try {
        const out = await exec(`pm2 describe ${service}`, 5000);
        return out.includes('online');
      } catch {
        return false;
      }
    },
    start: async (service) => {
      try {
        await exec(`pm2 start ${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to start ${service}: ${tail(errText(err))}`);
      }
    },
    stop: async (service) => {
      try {
        await exec(`pm2 stop ${service}`, 15000);
      } catch (err) {
        throw new Error(`Failed to stop ${service}: ${tail(errText(err))}`);
      }
    },
  };
}

/**
 * Controller for a manager over an injected shell runner.
 * `none` throws on construction (nothing sensible to control).
 */
export function serviceController(manager: InitSystem, exec: ControlExec): ServiceController {
  switch (manager) {
    case 'systemd':
      return systemd(exec);
    case 'openrc':
      return openrc(exec);
    case 'launchd':
      return launchd(exec);
    case 'pm2':
      return pm2(exec);
    case 'none':
      throw new Error('No supported init system detected (nothing to control)');
  }
}
