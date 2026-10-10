import { describe, expect, it } from 'vitest';
import { CATALOG, checkCommand, installCommand, isForced, itemById } from '../src/index.js';
import type { CatalogItem } from '../src/index.js';

function need(id: string): CatalogItem {
  const item = itemById(id);
  if (item === undefined) throw new Error(`catalog item missing: ${id}`);
  return item;
}

function cmdOf(item: CatalogItem, env: Parameters<typeof installCommand>[1]): string {
  const resolved = installCommand(item, env);
  if (!resolved.ok) throw new Error(`expected command: ${item.id}/${env}`);
  return resolved.cmd;
}

describe('pkgman catalog', () => {
  it('holds 26 unique Terwo-parity items, sorted by id', () => {
    expect(CATALOG).toHaveLength(26);
    const ids = CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(26);
    expect([...ids].sort()).toEqual(ids);
    for (const item of CATALOG) {
      expect(item.id).not.toBe('');
      expect(item.name).not.toBe('');
      expect(item.desc).not.toBe('');
      expect(item.install['termux']).toBeTypeOf('string');
    }
  });

  it('resolves every item on Termux', () => {
    for (const item of CATALOG) {
      const resolved = installCommand(item, 'termux');
      expect(resolved.ok).toBe(true);
    }
  });

  it('maps flagship packages per OS', () => {
    expect(cmdOf(need('nodejs'), 'debian')).toContain('nodesource.com');
    expect(cmdOf(need('golang'), 'arch')).toContain('pacman');
    expect(cmdOf(need('nginx'), 'alpine')).toContain('apk add nginx');
    expect(cmdOf(need('pm2'), 'windows')).toBe('npm install -g pm2');
  });

  it('answers honest unavailability naming env and id', () => {
    expect(installCommand(need('termux-api'), 'debian')).toEqual({
      ok: false,
      reason: 'Install command unavailable for debian (termux-api)',
    });
    expect(installCommand(need('cloudflared'), 'debian').ok).toBe(false);
    expect(installCommand(need('ffmpeg'), 'fedora').ok).toBe(false);
  });

  it('forces and probes per environment', () => {
    const nodejs = need('nodejs');
    expect(isForced(nodejs, 'termux')).toBe(true);
    expect(isForced(nodejs, 'debian')).toBe(false);
    expect(checkCommand(nodejs, 'termux')).toBeNull();
    expect(checkCommand(nodejs, 'debian')).toBe('command -v node >/dev/null 2>&1');

    const python = need('python');
    expect(checkCommand(python, 'debian')).toBe('command -v python3 >/dev/null 2>&1');
    expect(checkCommand(python, 'arch')).toBe('command -v python >/dev/null 2>&1');

    expect(checkCommand(need('nvm'), 'termux')).toBe('[ -f "$HOME/.nvm/nvm.sh" ]');
  });

  it('finds items by id', () => {
    expect(itemById('nginx')?.name).toBe('Nginx');
    expect(itemById('nope')).toBeUndefined();
  });
});
