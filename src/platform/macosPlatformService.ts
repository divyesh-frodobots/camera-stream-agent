import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { CommonPlatformService } from './commonPlatformService';
import type { PlatformServiceOptions } from './types';

export const LAUNCHD_LABEL = 'com.camerastream.agent';
export const PLIST_NAME = `${LAUNCHD_LABEL}.plist`;
export const PLIST_DIR = '/Library/LaunchDaemons';

export interface LaunchdPlistOptions {
  label: string;
  nodePath: string;
  scriptPath: string;
  workingDirectory: string;
  logDir: string;
}

/**
 * Builds a LaunchDaemon plist for the agent. Key properties:
 *  - RunAtLoad: starts the agent when the machine boots (before any user logs in)
 *  - KeepAlive: relaunches the agent automatically if it crashes or is killed
 *  - StandardOut/ErrorPath: persistent log files for the service
 */
export function buildLaunchdPlist(opts: LaunchdPlistOptions): string {
  const out = path.join(opts.logDir, 'camera-stream-agent.out.log');
  const err = path.join(opts.logDir, 'camera-stream-agent.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.scriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${opts.workingDirectory}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${out}</string>
  <key>StandardErrorPath</key>
  <string>${err}</string>
</dict>
</plist>
`;
}

/** Resolves the absolute path of the Node.js binary to bake into the plist. */
export function detectNodePath(): string {
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}

export interface MacOSPlatformServiceOptions extends PlatformServiceOptions {
  /** launchctl commands go here (injectable for tests). */
  execFileImpl?: typeof execFile;
  /** Where the plist lives (injectable for tests). */
  plistDir?: string;
}

/**
 * macOS implementation: the agent runs as a LaunchDaemon managed via
 * `launchctl` (bootstrap / bootout / kickstart / print). Requires root for
 * install/uninstall/start/stop/restart — the CLI wrapper elevates with sudo.
 */
export class MacOSPlatformService extends CommonPlatformService {
  private readonly exec: typeof execFile;
  private readonly plistDir: string;

  constructor(opts: MacOSPlatformServiceOptions) {
    super({ ...opts, name: 'macos' });
    this.exec = opts.execFileImpl ?? execFile;
    this.plistDir = opts.plistDir ?? PLIST_DIR;
  }

  private plistPath(): string {
    return path.join(this.plistDir, PLIST_NAME);
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.exec('launchctl', args, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stdout || '').trim() || err.message));
          return;
        }
        resolve((stdout || '').trim());
      });
    });
  }

  async isLoaded(): Promise<boolean> {
    try {
      const out = await this.run(['print', `system/${LAUNCHD_LABEL}`]);
      return out.length > 0;
    } catch {
      return false;
    }
  }

  async installService(): Promise<void> {
    const script = this.requireScript();
    await fs.mkdir(this.plistDir, { recursive: true });
    await fs.mkdir(this.logDir, { recursive: true });
    const plist = buildLaunchdPlist({
      label: LAUNCHD_LABEL,
      nodePath: detectNodePath(),
      scriptPath: script,
      workingDirectory: this.rootDir,
      logDir: this.logDir,
    });
    await fs.writeFile(this.plistPath(), plist, { mode: 0o644 });
    await this.bootstrap();
  }

  async uninstallService(): Promise<void> {
    await this.bootout();
    await fs.rm(this.plistPath(), { force: true });
  }

  async startService(): Promise<void> {
    this.requireScript();
    if (!(await this.isLoaded())) {
      await this.bootstrap();
      return;
    }
    await this.run(['kickstart', `system/${LAUNCHD_LABEL}`]);
  }

  async stopService(): Promise<void> {
    await this.bootout();
  }

  async restartService(): Promise<void> {
    this.requireScript();
    try {
      await this.run(['kickstart', '-k', `system/${LAUNCHD_LABEL}`]);
    } catch {
      await this.bootstrap();
    }
  }

  async statusService(): Promise<string> {
    try {
      return await this.run(['print', `system/${LAUNCHD_LABEL}`]);
    } catch {
      return `service "${LAUNCHD_LABEL}" is not loaded`;
    }
  }

  private async bootstrap(): Promise<void> {
    if (await this.isLoaded()) return;
    await this.run(['bootstrap', 'system', this.plistPath()]);
  }

  private async bootout(): Promise<void> {
    try {
      await this.run(['bootout', `system/${LAUNCHD_LABEL}`]);
    } catch {
      /* not loaded; nothing to stop */
    }
  }

  private requireScript(): string {
    if (!this.scriptPath) {
      throw new Error('scriptPath is required to manage the launchd service (run `npm run build` first)');
    }
    return this.scriptPath;
  }
}
