/**
 * `@olp/env-core` public entry.
 *
 * Single source of truth for host detection. Feature packages
 * must import from here instead of branching on the OS inline.
 */

export type {
  EnvId,
  PkgManId,
  ServiceManId,
  Libc,
  Environment,
  Signals,
} from './types.js';
export type { DetectOptions } from './detect.js';
export { detect, detectFromSignals, parseOsRelease, distroFromOsRelease } from './detect.js';
export { execEnv } from './execEnv.js';
