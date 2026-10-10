import { describe, expect, it } from 'vitest';
import { serviceController } from '../src/index.js';
import type { ControlExec } from '../src/index.js';
import { detectInit } from '../src/index.js';
import { olpServiceDef } from '../src/index.js';
import type { ServiceInputs } from '../src/index.js';

const INPUTS: ServiceInputs = {
  nodeBin: '/usr/bin/node',
  entry: '/opt/olp/dist/index.js',
  dataDir: '/home/ops/.olp',
  host: '127.0.0.1',
  port: 8080,
  user: 'ops',
};

function scriptedExec(script: Record<string, string | Error>): ControlExec & { commands: string[] } {
  const commands: string[] = [];
  const exec = ((cmd: string) => {
    commands.push(cmd);
    const outcome = script[cmd];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(typeof outcome === 'string' ? outcome : '');
  }) as ControlExec & { commands: string[] };
  exec.commands = commands;
  return exec;
}

describe('services detect', () => {
  it('prioritizes termux, darwin, systemd, openrc, none', () => {
    const base = { platform: 'linux', isTermux: false, hasSystemd: false, hasOpenrc: false };
    expect(detectInit(base)).toBe('none');
    expect(detectInit({ ...base, isTermux: true, hasSystemd: true })).toBe('pm2');
    expect(detectInit({ platform: 'darwin', isTermux: false, hasSystemd: false, hasOpenrc: false })).toBe('launchd');
    expect(detectInit({ ...base, hasSystemd: true, hasOpenrc: true })).toBe('systemd');
    expect(detectInit({ ...base, hasOpenrc: true })).toBe('openrc');
  });
});

describe('services units', () => {
  it('renders a systemd unit with absolute paths and localhost bind', () => {
    const def = olpServiceDef('systemd', INPUTS);
    expect(def.path).toBe('/etc/systemd/system/olp.service');
    expect(def.content).toContain('User=ops');
    expect(def.content).toContain('Restart=on-failure');
    expect(def.content).toContain('ExecStart=/usr/bin/node /opt/olp/dist/index.js');
    expect(def.content).toContain('Environment=PANEL_HOST=127.0.0.1');
    expect(def.content).not.toContain(' 0.0.0.0');
    expect(def.enable).toEqual(['systemctl daemon-reload', 'systemctl enable --now olp']);
  });

  it('renders openrc, launchd, and pm2 definitions', () => {
    const openrc = olpServiceDef('openrc', INPUTS);
    expect(openrc.path).toBe('/etc/init.d/olp');
    expect(openrc.content).toContain('#!/sbin/openrc-run');
    expect(openrc.content).toContain('command_user="ops"');
    expect(openrc.enable).toEqual(['rc-update add olp default', 'rc-service olp start']);

    const launchd = olpServiceDef('launchd', INPUTS);
    expect(launchd.path).toContain('olp.panel.plist');
    expect(launchd.content).toContain('<string>olp.panel</string>');
    expect(launchd.content).toContain('/opt/olp/dist/index.js');

    const pm2 = olpServiceDef('pm2', INPUTS);
    expect(pm2.content).toContain("name: 'olp'");
    expect(pm2.content).toContain('/opt/olp/dist/index.js');
    expect(pm2.enable).toEqual(['pm2 start ecosystem.config.js', 'pm2 save']);
  });

  it('rejects relative paths and the none manager', () => {
    expect(() => olpServiceDef('systemd', { ...INPUTS, nodeBin: 'node' })).toThrow(/nodeBin must be absolute/);
    expect(() => olpServiceDef('systemd', { ...INPUTS, entry: 'dist/index.js' })).toThrow(/entry must be absolute/);
    expect(() => olpServiceDef('none', INPUTS)).toThrow(/No supported init system/);
  });
});

describe('services control', () => {
  it('maps systemd commands with tailed failures', async () => {
    const exec = scriptedExec({ 'systemctl is-active --quiet olp': '' });
    const ctl = serviceController('systemd', exec);
    expect(await ctl.isActive('olp')).toBe(true);
    await ctl.start('olp');
    await ctl.stop('olp');
    expect(exec.commands).toEqual([
      'systemctl is-active --quiet olp',
      'systemctl start olp',
      'systemctl stop olp',
    ]);

    const failing = scriptedExec({ 'systemctl start olp': new Error('x'.repeat(600)) });
    const ctl2 = serviceController('systemd', failing);
    await expect(ctl2.start('olp')).rejects.toThrow(/^Failed to start olp: x{500}$/);
    const absent = scriptedExec({ 'systemctl is-active --quiet olp': new Error('inactive') });
    expect(await serviceController('systemd', absent).isActive('olp')).toBe(false);
  });

  it('maps openrc, launchd, and pm2 commands', async () => {
    const openrc = scriptedExec({ 'rc-service nginx status': '' });
    const openrcCtl = serviceController('openrc', openrc);
    expect(await openrcCtl.isActive('nginx')).toBe(true);
    await openrcCtl.start('nginx');
    await openrcCtl.stop('nginx');
    expect(openrc.commands).toEqual(['rc-service nginx status', 'rc-service nginx start', 'rc-service nginx stop']);

    const launchd = scriptedExec({ 'launchctl print gui/$(id -u)/olp.panel': new Error('no such service') });
    const launchdCtl = serviceController('launchd', launchd);
    expect(await launchdCtl.isActive('olp.panel')).toBe(false);
    expect(launchd.commands).toEqual(['launchctl print gui/$(id -u)/olp.panel']);

    const pm2 = scriptedExec({ 'pm2 describe olp': '│ online │' });
    const pm2Ctl = serviceController('pm2', pm2);
    expect(await pm2Ctl.isActive('olp')).toBe(true);
    const pm2Off = scriptedExec({ 'pm2 describe olp': '│ stopped │' });
    expect(await serviceController('pm2', pm2Off).isActive('olp')).toBe(false);
  });

  it('rejects the none manager', () => {
    expect(() => serviceController('none', scriptedExec({}))).toThrow(/No supported init system/);
  });
});
