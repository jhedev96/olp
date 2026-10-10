import type { InitSystem } from './types.js';

/** Injectable host signals (no direct fs access — callers probe). */
export interface InitSignals {
  platform: string;
  isTermux: boolean;
  hasSystemd: boolean;
  hasOpenrc: boolean;
}

/**
 * Detect the init system. Precedence: Termux → pm2, darwin → launchd,
 * systemd → openrc → none (callers fail actionable, never guess).
 */
export function detectInit(signals: InitSignals): InitSystem {
  if (signals.isTermux) return 'pm2';
  if (signals.platform === 'darwin') return 'launchd';
  if (signals.hasSystemd) return 'systemd';
  if (signals.hasOpenrc) return 'openrc';
  return 'none';
}
