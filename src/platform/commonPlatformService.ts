import path from 'node:path';
import type { PlatformName, PlatformService, PlatformServiceOptions } from './types';

/**
 * Shared behaviour for all platforms. Subclasses override the service
 * lifecycle (install/uninstall/start/stop/restart/status); everything else
 * is platform-agnostic already.
 */
export abstract class CommonPlatformService implements PlatformService {
  readonly name: PlatformName;
  readonly rootDir: string;
  readonly scriptPath: string | undefined;

  constructor(opts: PlatformServiceOptions & { name: PlatformName }) {
    this.name = opts.name;
    this.rootDir = opts.rootDir;
    this.scriptPath = opts.scriptPath;
  }

  /** Where the OS service writes its stdout/stderr logs. */
  get logDir(): string {
    return path.join(this.rootDir, 'logs');
  }

  /** `FFMPEG_PATH` env var wins; the default is the same command on both OSes. */
  get ffmpegBinary(): string {
    return process.env.FFMPEG_PATH ?? 'ffmpeg';
  }

  /** Plain SIGKILL; Windows overrides this with a tree kill. */
  async terminateProcessTree(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* process already gone */
    }
  }

  abstract installService(): Promise<void>;
  abstract uninstallService(): Promise<void>;
  abstract startService(): Promise<void>;
  abstract stopService(): Promise<void>;
  abstract restartService(): Promise<void>;
  abstract statusService(): Promise<string>;
}
