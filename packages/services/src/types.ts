/**
 * Shared service-supervision types. This package generates definitions
 * and maps commands — it never spawns processes (installers do).
 */

/** Init systems OLP knows how to install itself under. */
export type InitSystem = 'systemd' | 'openrc' | 'launchd' | 'pm2' | 'none';

/** Generated service definition: file content + where to put it + how to enable it. */
export interface ServiceDef {
  manager: InitSystem;
  content: string;
  path: string;
  enable: string[];
}

/** Service inputs (all paths absolute — relative entries boot-flake). */
export interface ServiceInputs {
  nodeBin: string;
  entry: string;
  dataDir: string;
  host: string;
  port: number;
  user: string;
}
