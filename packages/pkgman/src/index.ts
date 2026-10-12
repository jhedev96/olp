/**
 * `@olp/pkgman` public entry: per-OS install catalog (pure data + resolution).
 * No exec, no fs, no network — the server owns all side effects.
 */

export type { CatalogItem } from './catalog.js';
export { CATALOG, checkCommand, installCommand, isForced, itemById, updateCommand, upgradeCommand, versionCommand } from './catalog.js';
