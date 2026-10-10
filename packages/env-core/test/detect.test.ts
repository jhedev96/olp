import { describe, expect, it } from 'vitest';
import { detect, detectFromSignals, distroFromOsRelease, parseOsRelease } from '../src/detect.js';
import { execEnv } from '../src/execEnv.js';

const DEBIAN_RELEASE = 'PRETTY_NAME="Debian GNU/Linux 12"\nID=debian\nID_LIKE=debian\n';
const UBUNTU_RELEASE = 'PRETTY_NAME="Ubuntu 24.04"\nID=ubuntu\nID_LIKE=debian\n';
const ARCH_RELEASE = 'PRETTY_NAME="Arch Linux"\nID=arch\nID_LIKE="arch"\n';
const ALPINE_RELEASE = 'PRETTY_NAME="Alpine Linux v3.20"\nID=alpine\nID_LIKE=alpine\n';
const FEDORA_RELEASE = 'PRETTY_NAME="Fedora Linux 40"\nID=fedora\nID_LIKE=fedora\n';
const RHEL_RELEASE = 'PRETTY_NAME="Rocky Linux 9"\nID=rocky\nID_LIKE="rhel centos fedora"\n';

const noExists = () => false;

describe('parseOsRelease', () => {
  it('parses quoted id and like', () => {
    expect(parseOsRelease(UBUNTU_RELEASE)).toEqual({ id: 'ubuntu', like: 'debian' });
  });

  it('returns empty strings when absent', () => {
    expect(parseOsRelease('PRETTY_NAME="X"\n')).toEqual({ id: '', like: '' });
  });
});

describe('distroFromOsRelease', () => {
  it.each([
    ['debian', 'debian', 'debian'],
    ['ubuntu', 'debian', 'debian'],
    ['arch', 'arch', 'arch'],
    ['alpine', 'alpine', 'alpine'],
    ['fedora', 'fedora', 'fedora'],
    ['rocky', 'rhel centos fedora', 'rhel'],
  ] as const)('maps %s to %s', (id, like, expected) => {
    expect(distroFromOsRelease(id, like)).toBe(expected);
  });

  it('falls back to unknown', () => {
    expect(distroFromOsRelease('nixos', '')).toBe('unknown');
  });
});

describe('detectFromSignals', () => {
  it('detects termux via PREFIX', () => {
    const env = detectFromSignals(
      { platform: 'android', prefix: '/data/data/com.termux/files/usr' },
      noExists,
    );
    expect(env.id).toBe('termux');
    expect(env.pkgman).toBe('pkg');
    expect(env.service).toBe('pm2');
    expect(env.shell).toBe('sh');
  });

  it('detects termux via TERMUX_VERSION', () => {
    const env = detectFromSignals(
      { platform: 'linux', prefix: '', termuxVersion: '0.118' },
      noExists,
    );
    expect(env.id).toBe('termux');
  });

  it('detects debian / ubuntu / arch / alpine / fedora / rhel', () => {
    const cases = [
      [DEBIAN_RELEASE, 'debian', 'apt', 'systemd', 'glibc'],
      [UBUNTU_RELEASE, 'debian', 'apt', 'systemd', 'glibc'],
      [ARCH_RELEASE, 'arch', 'pacman', 'systemd', 'glibc'],
      [ALPINE_RELEASE, 'alpine', 'apk', 'openrc', 'musl'],
      [FEDORA_RELEASE, 'fedora', 'dnf', 'systemd', 'glibc'],
      [RHEL_RELEASE, 'rhel', 'dnf', 'systemd', 'glibc'],
    ] as const;
    for (const [release, id, pkgman, service, libc] of cases) {
      const env = detectFromSignals({ platform: 'linux', prefix: '', osRelease: release }, noExists);
      expect(env.id).toBe(id);
      expect(env.pkgman).toBe(pkgman);
      expect(env.service).toBe(service);
      expect(env.libc).toBe(libc);
    }
  });

  it('detects macos and windows stubs', () => {
    expect(detectFromSignals({ platform: 'darwin', prefix: '' }, noExists).id).toBe('macos');
    expect(detectFromSignals({ platform: 'win32', prefix: '' }, noExists).id).toBe('windows');
  });

  it('detects wsl2 wrapper with inner distro', () => {
    const env = detectFromSignals(
      {
        platform: 'linux',
        prefix: '',
        wslDistro: 'Ubuntu',
        procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2',
        osRelease: UBUNTU_RELEASE,
      },
      noExists,
    );
    expect(env.id).toBe('wsl2');
    expect(env.inner).toBe('debian');
    expect(env.isWsl).toBe(true);
    expect(env.service).toBe('wsl-passthrough');
    expect(env.pkgman).toBe('apt');
  });

  it('falls back to unknown without signals', () => {
    const env = detectFromSignals({ platform: 'linux', prefix: '' }, noExists);
    expect(env.id).toBe('unknown');
    expect(env.pkgman).toBe('none');
  });

  it('resolves bash when present', () => {
    const env = detectFromSignals({ platform: 'linux', prefix: '', osRelease: DEBIAN_RELEASE }, () => true);
    expect(env.shell).toBe('/bin/bash');
  });
});

describe('detect with injected I/O', () => {
  it('never throws on missing files', () => {
    const env = detect({
      platform: 'linux',
      env: {},
      readFile: () => null,
      existsSync: () => false,
    });
    expect(env.id).toBe('unknown');
  });

  it('reads PRETTY_NAME when available', () => {
    const env = detect({
      platform: 'linux',
      env: {},
      readFile: (p) => (p === '/etc/os-release' ? DEBIAN_RELEASE : null),
      existsSync: () => false,
    });
    expect(env.prettyName).toBe('Debian GNU/Linux 12');
  });
});

describe('execEnv', () => {
  it('appends pathExtra without duplicates and without mutating input', () => {
    const base = { PATH: '/usr/bin:/bin' };
    const out = execEnv(base, {
      id: 'termux',
      prettyName: 'Termux',
      pkgman: 'pkg',
      service: 'pm2',
      isWsl: false,
      prefix: '/data/data/com.termux/files/usr',
      shell: 'sh',
      pathExtra: ['/data/data/com.termux/files/usr/bin', '/system/bin'],
    });
    expect(out['PATH']).toBe('/usr/bin:/bin:/data/data/com.termux/files/usr/bin:/system/bin');
    expect(base['PATH']).toBe('/usr/bin:/bin');
    const again = execEnv(out, {
      id: 'termux',
      prettyName: 'Termux',
      pkgman: 'pkg',
      service: 'pm2',
      isWsl: false,
      prefix: 'x',
      shell: 'sh',
      pathExtra: ['/system/bin'],
    });
    expect(again['PATH']).toBe(out['PATH']);
  });

  it('returns a copy when no extras', () => {
    const base = { PATH: '/usr/bin' };
    const out = execEnv(base, {
      id: 'debian',
      prettyName: 'Debian',
      pkgman: 'apt',
      service: 'systemd',
      isWsl: false,
      libc: 'glibc',
      prefix: '',
      shell: 'sh',
      pathExtra: [],
    });
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
});
