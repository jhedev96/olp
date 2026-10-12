import { describe, expect, it } from 'vitest';
import { CATALOG, checkCommand, installCommand, isForced, itemById, updateCommand, upgradeCommand, versionCommand } from '../src/index.js';
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

  it('maps version probes (spike-verified overrides, sane defaults)', () => {
    // Overrides grounded in the W7-01 shell spike (see task notes).
    expect(versionCommand(need('nginx'))).toBe('nginx -v 2>&1 | head -n 1');
    expect(versionCommand(need('golang'))).toBe('go version 2>&1 | head -n 1');
    expect(versionCommand(need('tmux'))).toBe('tmux -V 2>&1 | head -n 1');
    expect(versionCommand(need('python'))).toBe('(python --version 2>&1 || python3 --version 2>&1) | head -n 1');
    expect(versionCommand(need('openssh'))).toBe('ssh -V 2>&1 | head -n 1');
    expect(versionCommand(need('zip'))).toBe('zip -v 2>&1 | head -n 2 | tail -n 1');
    expect(versionCommand(need('ffmpeg'))).toBe('ffmpeg -version 2>&1 | head -n 1');
    expect(versionCommand(need('nvm'))).toContain('nvm --version');
    // Defaults derive from bin (spike: node/bun/git/redis/9router all answer --version).
    expect(versionCommand(need('git'))).toBe('git --version 2>&1 | head -n 1');
    expect(versionCommand(need('nodejs'))).toBe('node --version 2>&1 | head -n 1');
    // termux-api keeps its derived probe (runtime failure maps to honest null).
    expect(versionCommand(need('termux-api'))).toBe('termux-battery-status --version 2>&1 | head -n 1');
  });

  it('exposes conf paths only where confident', () => {
    expect(need('nginx').conf).toBe('$PREFIX/etc/nginx/nginx.conf');
    expect(need('openssh').conf).toBe('~/.ssh/authorized_keys');
    expect(need('git').conf).toBe('~/.gitconfig');
    expect(need('tmux').conf).toBe('~/.tmux.conf');
    expect(need('cloudflared').conf).toBe('~/.cloudflared/config.yml');
    expect(need('mysql').conf).toBe('$PREFIX/etc/mysql/my.cnf');
    expect(need('redis').conf).toBeUndefined();
    expect(need('postgres').conf).toBeUndefined();
  });

  it('resolves manager update/upgrade per env, honest on windows', () => {
    expect(updateCommand('termux')).toEqual({ ok: true, cmd: 'pkg update' });
    expect(updateCommand('debian')).toEqual({ ok: true, cmd: 'apt-get update' });
    expect(updateCommand('arch')).toEqual({ ok: true, cmd: 'pacman -Sy' });
    expect(updateCommand('alpine')).toEqual({ ok: true, cmd: 'apk update' });
    expect(updateCommand('fedora')).toEqual({ ok: true, cmd: 'dnf makecache' });
    expect(updateCommand('macos')).toEqual({ ok: true, cmd: 'brew update' });
    expect(upgradeCommand('termux')).toEqual({ ok: true, cmd: 'pkg upgrade -y' });
    expect(upgradeCommand('debian')).toEqual({ ok: true, cmd: 'apt-get upgrade -y' });
    expect(upgradeCommand('arch')).toEqual({ ok: true, cmd: 'pacman -Su --noconfirm' });
    expect(upgradeCommand('alpine')).toEqual({ ok: true, cmd: 'apk upgrade' });
    expect(upgradeCommand('macos')).toEqual({ ok: true, cmd: 'brew upgrade' });
    expect(updateCommand('windows')).toEqual({ ok: false, reason: 'Repo update unavailable for windows' });
    expect(upgradeCommand('windows')).toEqual({ ok: false, reason: 'Batch upgrade unavailable for windows' });
  });
});
