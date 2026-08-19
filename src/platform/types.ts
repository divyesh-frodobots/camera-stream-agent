export type PlatformName = 'windows' | 'macos' | 'linux';

/**
 * Platform abstraction for the Camera Agent.
 *
 * The core agent (src/index.ts, services, ffmpeg, screenshots) must stay
 * platform-independent: it only ever depends on this interface. Everything
 * that differs between Windows and macOS lives in the implementations:
 * service installation/start/stop, FFmpeg binary resolution, OS-specific
 * process termination, and log/file paths.
 */
export interface PlatformService {
  readonly name: PlatformName;

  /** Absolute path where the service writes its log files. */
  readonly logDir: string;

  /** Absolute path of the script the service runs (dist/index.js). */
  readonly scriptPath: string | undefined;

  /**
   * FFmpeg binary: `FFMPEG_PATH` environment variable wins, otherwise an
   * OS-appropriate default. Core code must never hardcode a binary name.
   */
  readonly ffmpegBinary: string;

  /** Register the agent as an OS service (and start it). */
  installService(): Promise<void>;

  /** Remove the service (and stop it). */
  uninstallService(): Promise<void>;

  startService(): Promise<void>;

  stopService(): Promise<void>;

  restartService(): Promise<void>;

  /** Human-readable service status (for `npm run service:status`). */
  statusService(): Promise<string>;

  /**
   * Force-terminate a process tree. Windows may need a tree kill
   * (`taskkill /T /F`); other platforms use a plain SIGKILL.
   */
  terminateProcessTree(pid: number): Promise<void>;
}

export interface PlatformServiceOptions {
  /** Project root of the agent (working directory for the service). */
  rootDir: string;
  /** Absolute path to dist/index.js; required for service install/start. */
  scriptPath?: string;
}
