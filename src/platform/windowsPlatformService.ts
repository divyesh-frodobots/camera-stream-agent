import { execFile } from 'node:child_process';
import { CommonPlatformService } from './commonPlatformService';
import type { PlatformServiceOptions } from './types';

export const WINDOWS_SERVICE_NAME = 'CameraStreamAgent';

/** Minimal shape of the node-windows `Service` used here (injectable for tests). */
export interface WindowsServiceLike {
  exists(): void;
  install(): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  on(event: string, cb: (arg?: unknown) => void): void;
}

export interface WindowsPlatformServiceOptions extends PlatformServiceOptions {
  /** Inject a fake Service for tests (default: node-windows). */
  serviceFactory?: (opts: {
    name: string;
    description: string;
    script: string;
    nodeOptions: string[];
    maxRetries: number;
    wait: number;
    grow: number;
    startMode: string;
    workingDirectory: string;
  }) => WindowsServiceLike;
  /** taskkill goes here (injectable for tests). */
  execFileImpl?: typeof execFile;
}

/**
 * Windows implementation: the agent runs as a native Windows service via
 * `node-windows` (Windows SCM). The node-windows module is only loaded at
 * runtime on win32, so the same build runs on macOS.
 */
export class WindowsPlatformService extends CommonPlatformService {
  private readonly serviceFactory: WindowsPlatformServiceOptions['serviceFactory'];
  private readonly exec: typeof execFile;

  constructor(opts: WindowsPlatformServiceOptions) {
    super({ ...opts, name: 'windows' });
    this.serviceFactory = opts.serviceFactory;
    this.exec = opts.execFileImpl ?? execFile;
  }

  /** node-windows writes its out.log/err.log beside the running script. */
  override get logDir(): string {
    return this.rootDir;
  }

  /** Force-terminate the whole process tree (`taskkill /T /F`). */
  override async terminateProcessTree(pid: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.exec('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
  }

  private async getService(): Promise<WindowsServiceLike> {
    const script = this.requireScript();
    if (this.serviceFactory) {
      return this.serviceFactory({
        name: WINDOWS_SERVICE_NAME,
        description: 'Camera streaming agent: publishes IP camera RTSP streams to Agora channels via FFmpeg and uploads screenshots.',
        script,
        nodeOptions: ['--max-old-space-size=512'],
        maxRetries: 5,
        wait: 5,
        grow: 1.5,
        startMode: 'automatic',
        workingDirectory: this.rootDir,
      });
    }
    const { Service } = await import('node-windows');
    return new Service({
      name: WINDOWS_SERVICE_NAME,
      description: 'Camera streaming agent: publishes IP camera RTSP streams to Agora channels via FFmpeg and uploads screenshots.',
      script,
      nodeOptions: ['--max-old-space-size=512'],
      // Automatic restart on failure (Windows SCM):
      maxRetries: 5,
      wait: 5, // seconds between restart attempts
      grow: 1.5, // multiplier applied to `wait` after each failed attempt
      // Start automatically when Windows boots, so cameras keep streaming
      // after a reboot without any manual intervention (reboot recovery).
      startMode: 'automatic',
      workingDirectory: this.rootDir,
      logOnAs: null,
    });
  }

  private async waitForEvent(svc: WindowsServiceLike, event: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`service event "${event}" never fired`)), 60_000);
      svc.on(event, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async isInstalled(svc: WindowsServiceLike): Promise<boolean> {
    const exists = new Promise<boolean>((resolve) => svc.on('exists', (value) => resolve(Boolean(value))));
    svc.exists();
    return exists;
  }

  async installService(): Promise<void> {
    const svc = await this.getService();
    if (await this.isInstalled(svc)) return;
    const installed = this.waitForEvent(svc, 'install');
    svc.install();
    await installed;
    await this.startService();
  }

  async uninstallService(): Promise<void> {
    const svc = await this.getService();
    if (!(await this.isInstalled(svc))) return;
    const removed = this.waitForEvent(svc, 'uninstall');
    svc.uninstall();
    await removed;
  }

  async startService(): Promise<void> {
    const svc = await this.getService();
    const started = this.waitForEvent(svc, 'start');
    svc.start();
    await started;
  }

  async stopService(): Promise<void> {
    const svc = await this.getService();
    const stopped = this.waitForEvent(svc, 'stop');
    svc.stop();
    await stopped;
  }

  async restartService(): Promise<void> {
    await this.stopService();
    await this.startService();
  }

  async statusService(): Promise<string> {
    const svc = await this.getService();
    const exists = await this.isInstalled(svc);
    return exists
      ? `service "${WINDOWS_SERVICE_NAME}" exists (run 'sc query ${WINDOWS_SERVICE_NAME}' for state)`
      : `service "${WINDOWS_SERVICE_NAME}" does NOT exist`;
  }

  private requireScript(): string {
    if (!this.scriptPath) {
      throw new Error('scriptPath is required to manage the Windows service (run `npm run build` first)');
    }
    return this.scriptPath;
  }
}
