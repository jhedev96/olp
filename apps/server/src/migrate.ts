import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Registry files shared with Terwo's on-disk layout, copied once from
 * the legacy directory on first boot (newer OLP-only files are ignored
 * here by design — unknown futures must not migrate blindly).
 */
export const LEGACY_FILES = ['config.json', 'db.json', 'settings.json', 'sites.json', 'nginx.json'];

/** Injectable filesystem surface (memory fakes in tests). */
export interface MigrateIo {
  exists(path: string): boolean;
  copy(src: string, dest: string): void;
  mkdirp(dir: string): void;
}

const nodeIo: MigrateIo = {
  exists: existsSync,
  copy: (src, dest) => copyFileSync(src, dest),
  mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
};

/**
 * Copy absent registry files from the legacy Terwo directory.
 * Copy-if-absent per file (never overwrites), tolerant of unreadable
 * entries. Returns the copied file names. `copyFileSync` preserves the
 * source mode, so Terwo's `0600` files stay `0600`.
 */
export function migrateLegacy(dataDir: string, legacyDir: string, io: MigrateIo = nodeIo): string[] {
  const copied: string[] = [];
  if (dataDir === legacyDir) return copied;
  io.mkdirp(dataDir);
  for (const file of LEGACY_FILES) {
    const dest = join(dataDir, file);
    if (io.exists(dest)) continue;
    const src = join(legacyDir, file);
    if (!io.exists(src)) continue;
    try {
      io.copy(src, dest);
      copied.push(file);
    } catch {
      // best effort per file: one unreadable entry must not block the rest
    }
  }
  return copied;
}
