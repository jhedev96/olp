import { describe, expect, it } from 'vitest';
import { DAEMONS, scanDaemons } from '../src/daemons.js';

function files(table: Record<string, string | null>, dirs: string[] = ['1', '42', '7']): {
  readDir: (p: string) => string[];
  readFile: (p: string) => string | null;
} {
  return {
    readDir: (p: string) => {
      if (p === '/proc') return dirs;
      throw new Error(`unexpected dir: ${p}`);
    },
    readFile: (p: string) => table[p] ?? null,
  };
}

describe('scanDaemons', () => {
  it('matches comm names per daemon', () => {
    const found = scanDaemons(
      files({
        '/proc/1/comm': 'systemd\n',
        '/proc/42/comm': 'mysqld\n',
        '/proc/7/comm': 'crond\n',
      }),
    );
    expect(found).toEqual({ mariadb: true, postgres: false, redis: false, cronie: true });
  });

  it('falls back to status Name and covers all defs', () => {
    expect(DAEMONS.map((d) => d.id)).toEqual(['mariadb', 'postgres', 'redis', 'cronie']);
    const found = scanDaemons(
      files({
        '/proc/1/comm': '\n',
        '/proc/1/status': 'Name:\tpostgres\n',
        '/proc/42/comm': null,
        '/proc/42/status': 'Name:\tredis-server\n',
        '/proc/7/comm': 'other\n',
      }),
    );
    expect(found).toEqual({ mariadb: false, postgres: true, redis: true, cronie: false });
  });

  it('skips raced exits and floors directory failure', () => {
    const deps = files({ '/proc/1/comm': 'mysqld\n' });
    const racy = {
      ...deps,
      readFile: (p: string) => {
        if (p === '/proc/42/comm') throw new Error('gone');
        return files({ '/proc/1/comm': 'mysqld\n' }).readFile(p);
      },
    };
    expect(scanDaemons(racy)).toEqual({ mariadb: true, postgres: false, redis: false, cronie: false });
    expect(scanDaemons({ readDir: () => { throw new Error('no proc'); }, readFile: () => null })).toEqual({
      mariadb: false,
      postgres: false,
      redis: false,
      cronie: false,
    });
  });

  it('caps the pid scan', () => {
    const dirs = Array.from({ length: 600 }, (_, i) => String(i + 1));
    let reads = 0;
    const found = scanDaemons({
      readDir: () => dirs,
      readFile: (p: string) => {
        reads++;
        return p === '/proc/599/comm' ? 'postgres\n' : 'other\n';
      },
    });
    expect(reads).toBeLessThanOrEqual(512);
    expect(found.postgres).toBe(false);
  });
});
