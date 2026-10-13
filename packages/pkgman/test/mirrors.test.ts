import { describe, expect, it } from 'vitest';
import {
  mirrorSource,
  parseApkMirror,
  parseAptMirror,
  parseBrewRemote,
  parsePacmanMirror,
  parseYumMirror,
  purgeCommand,
} from '../src/index.js';

describe('pkgman mirrors', () => {
  it('describes sources per environment', () => {
    expect(mirrorSource('termux')).toMatchObject({ kind: 'apt', underPrefix: true });
    expect(mirrorSource('debian')).toMatchObject({ kind: 'apt', file: '/etc/apt/sources.list', exts: ['.list', '.sources'] });
    expect(mirrorSource('arch')).toMatchObject({ kind: 'pacman', file: '/etc/pacman.d/mirrorlist' });
    expect(mirrorSource('alpine')).toMatchObject({ kind: 'apk', file: '/etc/apk/repositories' });
    expect(mirrorSource('fedora')).toMatchObject({ kind: 'yum', exts: ['.repo'] });
    expect(mirrorSource('macos')).toMatchObject({ kind: 'brew' });
    expect(mirrorSource('windows')).toBeNull();
  });

  it('parses apt one-line and DEB822 sources', () => {
    expect(parseAptMirror('deb https://packages.termux.dev/apt/termux-main/ stable main\n')).toBe('packages.termux.dev');
    expect(parseAptMirror('# comment\n\nTypes: deb\nURIs: https://ports.ubuntu.com/ubuntu-ports\nSuites: noble\n')).toBe('ports.ubuntu.com');
    expect(parseAptMirror('just text\ndeb not-a-url x y\n')).toBeNull();
    expect(parseAptMirror('')).toBeNull();
  });

  it('parses pacman, apk, and yum sources', () => {
    expect(parsePacmanMirror('# comment\nServer = https://mirror.example.com/arch/$repo/os/$arch\n')).toBe('mirror.example.com');
    expect(parsePacmanMirror('nothing here\n')).toBeNull();
    expect(parseApkMirror('@edge https://mirror.example.com/alpine/edge/main\n')).toBe('mirror.example.com');
    expect(parseApkMirror('https://a.example.com/x\nhttps://b.example.com/y\n')).toBe('a.example.com');
    expect(parseApkMirror('')).toBeNull();
    expect(parseYumMirror('[base]\nname=Base\nbaseurl=https://mirror.example.com/fedora/$releasever/Everything/$basearch/os/\n')).toBe(
      'mirror.example.com',
    );
    expect(parseYumMirror('[fedora]\nmetalink=https://mirrors.fedoraproject.org/metalink?repo=fedora-40\n')).toBeNull();
    expect(parseYumMirror('')).toBeNull();
  });

  it('parses brew git remotes including scp syntax', () => {
    expect(parseBrewRemote('[remote "origin"]\n\turl = https://github.com/Homebrew/brew.git\n')).toBe('github.com');
    expect(parseBrewRemote('[remote "origin"]\n\turl = git@github.com:Homebrew/brew.git\n')).toBe('github.com');
    expect(parseBrewRemote('[remote "upstream"]\n\turl = https://example.com/x.git\n')).toBeNull();
    expect(parseBrewRemote('')).toBeNull();
  });

  it('resolves purge commands with honest windows null', () => {
    expect(purgeCommand('termux')).toEqual({ ok: true, cmd: 'pkg clean' });
    expect(purgeCommand('debian')).toEqual({ ok: true, cmd: 'apt-get clean' });
    expect(purgeCommand('arch')).toEqual({ ok: true, cmd: 'pacman -Sc --noconfirm' });
    expect(purgeCommand('alpine')).toEqual({ ok: true, cmd: 'apk cache clean' });
    expect(purgeCommand('fedora')).toEqual({ ok: true, cmd: 'dnf clean all' });
    expect(purgeCommand('macos')).toEqual({ ok: true, cmd: 'brew cleanup' });
    expect(purgeCommand('windows')).toEqual({ ok: false, reason: 'Cache purge unavailable for windows' });
  });
});
