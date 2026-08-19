/**
 * Service management CLI for the Camera Agent (platform-agnostic).
 *
 *   npm run service:install     register + start the service
 *   npm run service:start       start the service
 *   npm run service:stop        stop the service
 *   npm run service:restart     restart the service
 *   npm run service:uninstall   remove the service
 *   npm run service:status      show service existence/state
 *
 * All OS-specific behaviour lives in the PlatformService implementations
 * (src/platform/): Windows → node-windows (SCM), macOS → launchd/launchctl.
 *
 * Requires: `npm run build` first (the service runs dist/index.js).
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createPlatformService } from '../src/platform';

const ROOT = path.join(__dirname, '..');

const COMMANDS = ['install', 'start', 'stop', 'restart', 'uninstall', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.error(`Usage: npm run service:<${COMMANDS.join('|')}>`);
  process.exit(1);
}

function requireBuild(): string {
  const script = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(script)) {
    console.error('dist/index.js not found. Run `npm run build` first.');
    process.exit(2);
  }
  return script;
}

/**
 * Re-invokes the current script with sudo when root is required (macOS
 * LaunchDaemons live under /Library/LaunchDaemons).
 */
function ensureRoot(why: string): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const script = process.argv[1]!;
  const command = process.argv[2]!;
  console.log(`Elevating with sudo (${why})...`);
  execFileSync('sudo', ['-E', 'npx', 'tsx', script, command], { cwd: ROOT, stdio: 'inherit' });
  process.exit(0);
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) usage();

  const platform = createPlatformService(process.platform, {
    rootDir: ROOT,
    scriptPath: requireBuild(),
  });

  if (platform.name === 'macos' && command !== 'status') {
    ensureRoot(`manage the launchd LaunchDaemon`);
  }

  if (command === 'status') {
    console.log(await platform.statusService());
    return;
  }

  if (command === 'install') {
    await platform.installService();
    console.log(`Service installed and started. Logs: ${platform.logDir}`);
    return;
  }

  if (command === 'uninstall') {
    await platform.uninstallService();
    console.log('Service uninstalled.');
    return;
  }

  if (command === 'start') {
    await platform.startService();
    console.log('Service started.');
    return;
  }

  if (command === 'stop') {
    await platform.stopService();
    console.log('Service stopped.');
    return;
  }

  await platform.restartService();
  console.log('Service restarted.');
}

void main();