import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import type { AgentConfigCamera } from '../types/agentConfig';
import type { AgentApi } from '../api/agentApi';
import { maskUrl } from '../utils/mask';
import type { Logger } from '../utils/loggerTypes';

interface ScreenshotProc {
  camera: AgentConfigCamera;
  child: ChildProcess;
  file: string;
  lastMtimeMs: number;
  running: boolean;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Maintains the latest JPEG frame per camera using a dedicated lightweight
 * FFmpeg process (`-vf fps=1 -update 1`), separate from the RTSP->RTMP
 * streaming process so screenshots never interfere with the live stream.
 *
 * The upload loop POSTs the latest frame to the backend at a configurable
 * interval - not at video frame rate.
 */
export class ScreenshotService {
  private readonly procs = new Map<number, ScreenshotProc>();
  private uploadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      api: AgentApi;
      logger: Logger;
      ffmpegPath?: string;
      /** OS-specific process termination (platform layer); defaults to SIGKILL. */
      killProcess?: (pid: number) => void;
      dir?: string;
      intervalSeconds?: number;
      spawnImpl?: typeof spawn;
    },
  ) {}

  private dir(): string {
    return this.deps.dir ?? env.SCREENSHOT_DIR;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
  }

  startUploadLoop(): void {
    if (this.uploadTimer) return;
    const interval = this.deps.intervalSeconds ?? env.SCREENSHOT_INTERVAL_SECONDS;
    this.uploadTimer = setInterval(() => {
      void this.uploadLoop();
    }, interval * 1000);
  }

  async start(camera: AgentConfigCamera): Promise<void> {
    await this.ensureDir();
    const existing = this.procs.get(camera.id);
    if (
      existing &&
      existing.running &&
      existing.camera.rtspUrl === camera.rtspUrl &&
      existing.camera.video.rtspTransport === camera.video.rtspTransport
    ) {
      return;
    }
    await this.stop(camera.id);

    const file = path.join(this.dir(), `${camera.id}.jpg`);
    const transport = camera.video.rtspTransport === 'udp' ? 'udp' : 'tcp';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      transport,
      '-i',
      camera.rtspUrl,
      '-an',
      '-vf',
      'fps=1',
      '-q:v',
      '4',
      '-update',
      '1',
      '-y',
      file,
    ];

    this.deps.logger.info(
      { cameraId: camera.id, cameraName: camera.name, rtsp: maskUrl(camera.rtspUrl) },
      'screenshot capture process starting',
    );

    let child: ChildProcess;
    try {
      // stdin is piped so a 'q' can request a clean exit; -update 1 keeps only
      // the latest frame on disk (never a video-rate stream of images).
      child = (this.deps.spawnImpl ?? spawn)(this.deps.ffmpegPath ?? env.FFMPEG_PATH, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      this.deps.logger.error(
        { cameraId: camera.id, err: err instanceof Error ? err.message : err },
        'screenshot process spawn failed',
      );
      return;
    }

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.deps.logger.debug({ cameraId: camera.id, line: chunk.trim().slice(0, 200) }, 'screenshot ffmpeg');
    });

    this.procs.set(camera.id, {
      camera,
      child,
      file,
      lastMtimeMs: 0,
      running: true,
    });

    child.on('exit', (code) => {
      const proc = this.procs.get(camera.id);
      if (proc && proc.child === child) {
        proc.running = false;
        this.deps.logger.warn(
          { cameraId: camera.id, code },
          'screenshot capture process exited; it will be restarted on next upload cycle',
        );
      }
    });
  }

  async stop(cameraId: number): Promise<void> {
    const proc = this.procs.get(cameraId);
    if (!proc) return;
    proc.running = false;
    this.procs.delete(cameraId);
    try {
      proc.child.stdin?.write('q');
    } catch {
      /* ignore */
    }
    const child = proc.child;
    const timer = setTimeout(() => {
      if (this.deps.killProcess) {
        this.deps.killProcess(child.pid!);
      } else {
        child.kill('SIGKILL');
      }
    }, 3000);
    child.once('exit', () => clearTimeout(timer));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = null;
  }

  /** Reads the latest frame files and uploads them (only when changed). */
  private async uploadLoop(): Promise<void> {
    for (const [cameraId, proc] of this.procs) {
      if (!proc.running) {
        // restart the capture process if it died
        void this.start(proc.camera);
        continue;
      }
      try {
        const stat = await fs.stat(proc.file);
        if (stat.mtimeMs <= proc.lastMtimeMs) continue;
        proc.lastMtimeMs = stat.mtimeMs;

        const buffer = await fs.readFile(proc.file);
        if (buffer.length < 3 || !buffer.subarray(0, 3).equals(JPEG_MAGIC)) continue;

        await this.deps.api.uploadScreenshot(cameraId, buffer);
        this.deps.logger.debug({ cameraId, bytes: buffer.length }, 'screenshot uploaded');
      } catch (err) {
        this.deps.logger.debug(
          { cameraId, err: err instanceof Error ? err.message : err },
          'screenshot upload skipped',
        );
      }
    }
  }
}