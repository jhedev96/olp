/**
 * `@olp/services` public entry: init detection, unit definitions, and
 * service control mapping. Generation only — this package never spawns.
 */

export type { InitSystem, ServiceDef, ServiceInputs } from './types.js';
export type { InitSignals } from './detect.js';
export { detectInit } from './detect.js';
export { olpServiceDef } from './units.js';
export type { ServiceController, ControlExec } from './control.js';
export { serviceController } from './control.js';
