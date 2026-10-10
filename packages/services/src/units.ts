import { isAbsolute } from 'node:path';
import type { InitSystem, ServiceDef, ServiceInputs } from './types.js';

function requireAbsolute(label: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute (got ${JSON.stringify(value)})`);
}

function envBlock(inputs: ServiceInputs): string {
  return (
    `Environment=PANEL_HOST=${inputs.host}\n` +
    `Environment=PANEL_PORT=${inputs.port}\n` +
    `Environment=OLP_DATA_DIR=${inputs.dataDir}\n`
  );
}

function systemdUnit(inputs: ServiceInputs): ServiceDef {
  return {
    manager: 'systemd',
    path: '/etc/systemd/system/olp.service',
    content:
      '[Unit]\n' +
      'Description=OpenLocalPanel\n' +
      'After=network.target\n' +
      '\n' +
      '[Service]\n' +
      `User=${inputs.user}\n` +
      'Restart=on-failure\n' +
      envBlock(inputs) +
      `ExecStart=${inputs.nodeBin} ${inputs.entry}\n` +
      '\n' +
      '[Install]\n' +
      'WantedBy=multi-user.target\n',
    enable: ['systemctl daemon-reload', 'systemctl enable --now olp'],
  };
}

function openrcScript(inputs: ServiceInputs): ServiceDef {
  return {
    manager: 'openrc',
    path: '/etc/init.d/olp',
    content:
      '#!/sbin/openrc-run\n' +
      `# OpenLocalPanel (data: ${inputs.dataDir})\n` +
      `command="${inputs.nodeBin}"\n` +
      `command_args="${inputs.entry}"\n` +
      `command_user="${inputs.user}"\n` +
      'command_background="yes"\n' +
      'respawn="yes"\n' +
      `export PANEL_HOST="${inputs.host}"\n` +
      `export PANEL_PORT="${inputs.port}"\n` +
      `export OLP_DATA_DIR="${inputs.dataDir}"\n`,
    enable: ['rc-update add olp default', 'rc-service olp start'],
  };
}

function launchdPlist(inputs: ServiceInputs): ServiceDef {
  const home = inputs.dataDir.split('/').slice(0, 3).join('/');
  return {
    manager: 'launchd',
    path: `${home}/Library/LaunchAgents/olp.panel.plist`,
    content:
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n<dict>\n' +
      '\t<key>Label</key><string>olp.panel</string>\n' +
      `\t<key>ProgramArguments</key><array><string>${inputs.nodeBin}</string><string>${inputs.entry}</string></array>\n` +
      '\t<key>RunAtLoad</key><true/>\n' +
      '\t<key>KeepAlive</key><true/>\n' +
      '\t<key>EnvironmentVariables</key><dict>\n' +
      `\t\t<key>PANEL_HOST</key><string>${inputs.host}</string>\n` +
      `\t\t<key>PANEL_PORT</key><string>${inputs.port}</string>\n` +
      `\t\t<key>OLP_DATA_DIR</key><string>${inputs.dataDir}</string>\n` +
      '\t</dict>\n</dict>\n</plist>\n',
    enable: ['launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/olp.panel.plist', 'launchctl kickstart -k gui/$(id -u)/olp.panel'],
  };
}

function pm2Ecosystem(inputs: ServiceInputs): ServiceDef {
  return {
    manager: 'pm2',
    // Installers may relocate this next to the checkout; pm2 accepts an absolute path.
    path: `${inputs.dataDir}/ecosystem.config.js`,
    content:
      '// OLP pm2 ecosystem (Termux parity: start, save, resurrect on boot)\n' +
      'module.exports = {\n' +
      '  apps: [\n' +
      '    {\n' +
      "      name: 'olp',\n" +
      `      script: ${JSON.stringify(inputs.entry)},\n` +
      '      instances: 1,\n' +
      '      autorestart: true,\n' +
      '      watch: false,\n' +
      "      max_memory_restart: '300M',\n" +
      '      env: {\n' +
      "        NODE_ENV: 'production',\n" +
      `        PANEL_HOST: ${JSON.stringify(inputs.host)},\n` +
      `        PANEL_PORT: ${JSON.stringify(String(inputs.port))},\n` +
      `        OLP_DATA_DIR: ${JSON.stringify(inputs.dataDir)},\n` +
      '      },\n' +
      '    },\n' +
      '  ],\n' +
      '};\n',
    enable: ['pm2 start ecosystem.config.js', 'pm2 save'],
  };
}

/**
 * Generate the OLP service definition for a manager. `nodeBin` and
 * `entry` must be absolute; `none` throws (nothing sensible to emit).
 */
export function olpServiceDef(manager: InitSystem, inputs: ServiceInputs): ServiceDef {
  requireAbsolute('nodeBin', inputs.nodeBin);
  requireAbsolute('entry', inputs.entry);
  requireAbsolute('dataDir', inputs.dataDir);
  switch (manager) {
    case 'systemd':
      return systemdUnit(inputs);
    case 'openrc':
      return openrcScript(inputs);
    case 'launchd':
      return launchdPlist(inputs);
    case 'pm2':
      return pm2Ecosystem(inputs);
    case 'none':
      throw new Error('No supported init system detected (no unit to generate)');
  }
}
