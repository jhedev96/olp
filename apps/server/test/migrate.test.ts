import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_FILES, migrateLegacy } from '../src/migrate.js';
import type { MigrateIo } from '../src/migrate.js';

function memoryIo(seed: string[] = [], failures: string[] = []): MigrateIo & {
  files: Set<string>;
  copied: Array<[string, string]>;
} {
  const files = new Set(seed);
  const copied: Array<[string, string]> = [];
  return {
    files,
    copied,
    exists: (path) => files.has(path),
    copy: (src, dest) => {
      if (failures.includes(src)) throw new Error('unreadable');
      files.add(dest);
      copied.push([src, dest]);
    },
    mkdirp: () => {},
  };
}

describe('migrate legacy registries', () => {
  it('copies absent files and skips the rest', () => {
    const io = memoryIo(['/legacy/db.json', '/legacy/sites.json', '/data/db.json']);
    const copied = migrateLegacy('/data', '/legacy', io);
    expect(copied.sort()).toEqual(['sites.json']);
    expect(io.files.has('/data/sites.json')).toBe(true);
    expect(io.files.has('/data/db.json')).toBe(true);
    expect(io.copied).toEqual([['/legacy/sites.json', '/data/sites.json']]);
  });

  it('copies the full known set on a fresh boot', () => {
    const io = memoryIo(LEGACY_FILES.map((f) => `/legacy/${f}`));
    expect(migrateLegacy('/data', '/legacy', io).sort()).toEqual([...LEGACY_FILES].sort());
  });

  it('is a no-op for same dirs and tolerates failures', () => {
    const same = memoryIo(['/data/db.json']);
    expect(migrateLegacy('/data', '/data', same)).toEqual([]);
    expect(same.copied).toHaveLength(0);

    const failing = memoryIo(['/legacy/db.json', '/legacy/sites.json'], ['/legacy/db.json']);
    expect(migrateLegacy('/data', '/legacy', failing)).toEqual(['sites.json']);
  });

  it('migrates on real server boot (guide claim)', async () => {
    const { buildServer } = await import('../src/index.js');
    const { hashPassword } = await import('@olp/auth');
    const base = mkdtempSync(join(tmpdir(), 'olp-mig-'));
    const legacyDir = join(base, 'legacy');
    const dataDir = join(base, 'data');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'config.json'),
      JSON.stringify({ username: 'old', salt: '0'.repeat(32), hash: hashPassword('pw123456', '0'.repeat(32)) }),
    );
    writeFileSync(join(legacyDir, 'db.json'), JSON.stringify({ mysql: { host: 'db' } }));
    const { app, auth } = buildServer({ dataDir, legacyDir, root: join(base, 'root') });
    expect(auth.config.username).toBe('old');
    expect(JSON.parse(readFileSync(join(dataDir, 'db.json'), 'utf8'))).toEqual({ mysql: { host: 'db' } });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'old', password: 'pw123456' },
    });
    expect(login.statusCode).toBe(200);
  });
});
