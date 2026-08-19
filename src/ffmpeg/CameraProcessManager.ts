import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { env } from '../config/env';
import type { AgentConfigCamera, CameraRuntimeStatus } from '../types/agentConfig';
import { buildFfmpegArgs } from './ffmpegArgs';
import { ProgressTracker, parseFfmpegLine, type FfmpegErrorCategory } from './ffmpegLogParser';
import { ExponentialBackoff } from '../monitoring/backoff';
import { maskSecret, maskUrl } from '../utils/mask';
import type { Logger } from '../utils/loggerTypes';

export interface CameraProcessState {
  cameraId: number;
  cameraName: string;
  status: CameraRuntimeStatus;
  pid: number | null;
  uptime: number;
  restartCount: number;
  lastError: string | null;
  lastErrorCategory: FfmpegErrorCategory | null;
  lastOutput: string | null;
  startedAt: Date | null;
  lastHealthyAt: Date | null;
  progress: {
    frame: number;
    fps: number;
    bitrateKbps: number;
  };
}

interface ManagedProcess {
  camera: AgentConfigCamera;
  child: ChildProcess;
  startedAt: Date;
  lastHealthyAt: Date | null;
  // set when the stream first reaches STREAMING after a (re)start; the backoff
  // reset check compares against this so a fresh progress tick cannot reset
  // the counter prematurely
  healthySince: Date | null;
  status: CameraRuntimeStatus;
  lastError: string | null;
  lastErrorCategory: FfmpegErrorCategory | null;
  tracker: ProgressTracker;
  recentLog: string[];
  // true when the stop was requested by shutdown()/stop(): no auto-restart
  intentionallyStopped: boolean;
  // when the process exits (for any reason) schedule a restart
  restartOnExit: boolean;
  killTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
}

const LOG_RING_SIZE = 50;

/**
 * Spawns and supervises one FFmpeg process per camera.
 *
 * - spawn with an argument array (never a shell string)
 * - captures stdout (-progress) and stderr (errors)
 * - restarts with exponential backoff after crashes
 * - kills the process and restarts when it is alive but the stream has not
 *   produced frames for FFMPEG_HEALTH_TIMEOUT_SECONDS
 * - resets the backoff counter after HEALTHY_RESET_SECONDS of healthy frames
 * - graceful shutdown: sends "q" to FFmpeg stdin, SIGKILL after timeout
 */
export class CameraProcessManager extends EventEmitter {
  private readonly processes = new Map<number, ManagedProcess>();
  private readonly backoffs = new Map<number, ExponentialBackoff>();
  // pending restart timers per camera; cancelled on stop() so a camera that
  // was intentionally stopped does not respawn after the backoff window
  private readonly restartTimers = new Map<number, NodeJS.Timeout>();
  // cameras that were ever started; keeps status reporting (e.g. STOPPED,
  // restart counts) alive even while no FFmpeg process is running
  private readonly knownCameras = new Set<number>();

  constructor(
    private readonly deps: {
      ffmpegPath?: string;
      /** OS-specific process termination (platform layer); defaults to SIGKILL. */
      killProcess?: (pid: number) => void;
      logger: Logger;
      spawnImpl?: typeof spawn;
    },
  ) {
    super();
  }

  /** Subscribes to per-camera state changes. */
  onStateChange(listener: (state: CameraProcessState) => void): () => void {
    this.on('stateChange', listener as (...args: unknown[]) => void);
    return () => this.off('stateChange', listener as (...args: unknown[]) => void);
  }

  private emitStateChange(state: CameraProcessState): void {
    this.emit('stateChange', state);
  }

  /** Starts (or restarts with new configuration) the camera process. */
  async start(camera: AgentConfigCamera): Promise<void> {
    const existing = this.processes.get(camera.id);
    if (existing && !existing.child.killed && existing.child.exitCode === null && !existing.intentionallyStopped) {
      this.deps.logger.debug({ cameraId: camera.id }, 'process already running, skipping start');
      return;
    }
    if (existing) {
      await this.stopInternalAsync(camera.id, 'configuration changed; restarting');
    }
    this.spawnProcess(camera);
  }

  /** Stops the camera process without scheduling a restart. */
  async stop(cameraId: number, reason = 'stopped'): Promise<void> {
    this.cancelRestart(cameraId);
    await this.stopInternalAsync(cameraId, reason);
    this.backoffs.delete(cameraId);
  }

  /**
   * Stops the camera and forgets it entirely: it will no longer be reported
   * in status/heartbeats. Used when the camera is removed from the config.
   */
  async forget(cameraId: number, reason = 'camera removed'): Promise<void> {
    await this.stop(cameraId, reason);
    this.knownCameras.delete(cameraId);
  }

  /** Stops all processes (shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const m = this.processes.get(id);
        if (m) {
          m.intentionallyStopped = true;
          m.restartOnExit = false;
          this.clearTimers(m);
        }
        await this.gracefulStop(id);
      }),
    );
    this.knownCameras.clear();
    this.backoffs.clear();
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
  }

  getState(cameraId: number): CameraProcessState | null {
    const m = this.processes.get(cameraId);
    if (!m) {
      return {
        cameraId,
        cameraName: '',
        status: 'STOPPED',
        pid: null,
        uptime: 0,
        restartCount: this.backoffs.get(cameraId)?.getAttempts() ?? 0,
        lastError: null,
        lastErrorCategory: null,
        lastOutput: null,
        startedAt: null,
        lastHealthyAt: null,
        progress: { frame: 0, fps: 0, bitrateKbps: 0 },
      };
    }
    const tracker = m.tracker.snapshot();
    return {
      cameraId: m.camera.id,
      cameraName: m.camera.name,
      status: m.status,
      pid: m.child.pid ?? null,
      uptime: Math.floor((Date.now() - m.startedAt.getTime()) / 1000),
      restartCount: this.backoffs.get(cameraId)?.getAttempts() ?? 0,
      lastError: m.lastError,
      lastErrorCategory: m.lastErrorCategory,
      lastOutput: m.recentLog.length > 0 ? m.recentLog[m.recentLog.length - 1]! : null,
      startedAt: m.startedAt,
      lastHealthyAt: m.lastHealthyAt,
      progress: { frame: tracker.frame, fps: tracker.fps, bitrateKbps: tracker.bitrateKbps },
    };
  }

  getAllStates(): CameraProcessState[] {
    return [...this.knownCameras]
      .map((id) => this.getState(id))
      .filter((s): s is CameraProcessState => s !== null);
  }

  private spawnProcess(camera: AgentConfigCamera): void {
    const ffmpegPath = this.deps.ffmpegPath ?? env.FFMPEG_PATH;
    const args = buildFfmpegArgs(camera);
    this.deps.logger.info(
      {
        cameraId: camera.id,
        cameraName: camera.name,
        ffmpeg: ffmpegPath,
        rtsp: maskUrl(camera.rtspUrl),
        rtmp: `${maskSecret(camera.rtmpPublishUrl.split('/').slice(0, -1).join('/'))}/***`,
        transcode: camera.video.transcodeEnabled,
      },
      'ffmpeg starting',
    );

    let child: ChildProcess;
    try {
      child = (this.deps.spawnImpl ?? spawn)(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.deps.logger.error(
        { cameraId: camera.id, err: err instanceof Error ? err.message : err },
        'failed to spawn ffmpeg (is FFMPEG_PATH correct?)',
      );
      this.scheduleRestart(camera, 'spawn failed');
      return;
    }

    const managed: ManagedProcess = {
      camera,
      child,
      startedAt: new Date(),
      lastHealthyAt: null,
      healthySince: null,
      status: 'STARTING',
      lastError: null,
      lastErrorCategory: null,
      tracker: new ProgressTracker(),
      recentLog: [],
      intentionallyStopped: false,
      restartOnExit: true,
      killTimer: null,
      healthTimer: null,
      startTimer: null,
    };
    this.processes.set(camera.id, managed);
    this.knownCameras.add(camera.id);
    this.emitStateChange(this.getState(camera.id)!);

    const healthTimer = setTimeout(() => this.checkHealth(camera.id), env.FFMPEG_HEALTH_TIMEOUT_SECONDS * 1000);
    healthTimer.unref?.();
    managed.healthTimer = healthTimer;

    // If the stream has not produced its first frame within the startup
    // window, kill it so the backoff loop reconnects from scratch.
    const startTimer = setTimeout(() => this.checkStartTimeout(camera.id), env.FFMPEG_START_TIMEOUT_MS);
    startTimer.unref?.();
    managed.startTimer = startTimer;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = parseFfmpegLine(line);
        if (parsed.kind === 'progress' && parsed.progressKey && parsed.progressValue !== undefined) {
          managed.tracker.update(parsed.progressKey, parsed.progressValue);
          if (parsed.progressKey === 'progress' && parsed.progressValue === 'continue') {
            managed.lastHealthyAt = new Date();
            if (managed.startTimer) {
              clearTimeout(managed.startTimer);
              managed.startTimer = null;
            }
            if (managed.status !== 'STREAMING') {
              managed.status = 'STREAMING';
              managed.healthySince = new Date();
              this.deps.logger.info({ cameraId: camera.id, cameraName: camera.name }, 'stream healthy');
              this.emitStateChange(this.getState(camera.id)!);
            }
            this.noteHealth(managed);
          }
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        managed.recentLog.push(line.trim());
        if (managed.recentLog.length > LOG_RING_SIZE) managed.recentLog.shift();
        const parsed = parseFfmpegLine(line);
        if (parsed.kind === 'error') {
          managed.lastError = line.trim().slice(0, 500);
          managed.lastErrorCategory = parsed.errorCategory ?? null;
          this.deps.logger.warn(
            {
              cameraId: camera.id,
              cameraName: camera.name,
              category: parsed.errorCategory,
              error: line.trim().slice(0, 300),
            },
            'ffmpeg error line',
          );
          if (managed.status === 'STARTING') {
            managed.status = 'RECONNECTING';
            this.emitStateChange(this.getState(camera.id)!);
          }
        } else if (parsed.kind === 'info' && /streaming|flv|write|connected|handshake|opened/i.test(line)) {
          this.deps.logger.debug({ cameraId: camera.id, line: line.trim().slice(0, 200) }, 'ffmpeg log');
        }
      }
    });

    child.on('error', (err) => {
      this.deps.logger.error({ cameraId: camera.id, err: err.message }, 'ffmpeg process error');
      managed.lastError = err.message;
      managed.lastErrorCategory = 'generic';
    });

    child.on('close', (code, signal) => {
      this.onProcessExit(camera.id, code, signal);
    });
  }

  private onProcessExit(cameraId: number, code: number | null, signal: string | null): void {
    const m = this.processes.get(cameraId);
    if (!m) return;
    this.clearTimers(m);
    this.processes.delete(cameraId);
    const wasHealthy = m.lastHealthyAt !== null;

    this.deps.logger.info(
      { cameraId, cameraName: m.camera.name, code, signal, intentionallyStopped: m.intentionallyStopped },
      'ffmpeg exited',
    );

    if (m.intentionallyStopped && !m.restartOnExit) {
      this.emitStateChange(this.getState(cameraId)!);
      return;
    }

    // Crash, network loss, or a health-kill: restart with backoff.
    const reason = m.lastError ?? (signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
    this.scheduleRestart(m.camera, reason, wasHealthy);
  }

  private scheduleRestart(camera: AgentConfigCamera, reason: string, wasHealthy = false): void {
    const backoff = this.backoffs.get(camera.id) ?? new ExponentialBackoff(env.RESTART_BASE_DELAY_SECONDS, env.RESTART_MAX_DELAY_SECONDS);
    this.backoffs.set(camera.id, backoff);
    if (wasHealthy) {
      this.deps.logger.warn({ cameraId: camera.id, cameraName: camera.name, reason }, 'stream lost; restart scheduled');
    }
    const delay = backoff.nextDelayMs();
    this.deps.logger.warn(
      { cameraId: camera.id, cameraName: camera.name, delayMs: delay, attempt: backoff.getAttempts(), reason },
      'scheduling ffmpeg restart',
    );
    const timer = setTimeout(() => {
      this.restartTimers.delete(camera.id);
      if (this.processes.has(camera.id)) return;
      this.spawnProcess(camera);
    }, delay);
    this.restartTimers.set(camera.id, timer);
  }

  private cancelRestart(cameraId: number): void {
    const timer = this.restartTimers.get(cameraId);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(cameraId);
    }
  }

  private checkHealth(cameraId: number): void {
    const m = this.processes.get(cameraId);
    if (!m || m.intentionallyStopped) return;
    const lastUpdate = m.tracker.getLastUpdateAt();
    const stalled = lastUpdate === null || Date.now() - lastUpdate > env.FFMPEG_HEALTH_TIMEOUT_SECONDS * 1000;
    if (stalled) {
      this.deps.logger.warn(
        { cameraId, cameraName: m.camera.name, lastUpdateAt: lastUpdate ? new Date(lastUpdate).toISOString() : null },
        'stream stalled (no frames); killing ffmpeg to force reconnect',
      );
      m.lastError = 'stream stalled: no frames produced';
      m.lastErrorCategory = 'generic';
      m.status = 'RECONNECTING';
      m.restartOnExit = true;
      m.intentionallyStopped = false;
      this.emitStateChange(this.getState(cameraId)!);
      this.clearTimers(m);
      void this.gracefulStop(cameraId);
      return;
    }
    const timer = setTimeout(() => this.checkHealth(cameraId), env.FFMPEG_HEALTH_TIMEOUT_SECONDS * 1000);
    timer.unref?.();
    m.healthTimer = timer;
  }

  /** Kills a process that never produced its first frame within the startup timeout. */
  private checkStartTimeout(cameraId: number): void {
    const m = this.processes.get(cameraId);
    if (!m || m.intentionallyStopped) return;
    if (m.lastHealthyAt !== null) return; // reached STREAMING; nothing to do
    this.deps.logger.warn(
      { cameraId, cameraName: m.camera.name, timeoutMs: env.FFMPEG_START_TIMEOUT_MS },
      'stream did not start within the startup timeout; killing to force reconnect',
    );
    m.lastError = `stream did not start within ${env.FFMPEG_START_TIMEOUT_MS}ms`;
    m.lastErrorCategory = 'generic';
    m.status = 'RECONNECTING';
    m.restartOnExit = true;
    m.intentionallyStopped = false;
    this.emitStateChange(this.getState(cameraId)!);
    this.clearTimers(m);
    void this.gracefulStop(cameraId);
  }

  /** Resets the backoff counter once the stream has been healthy long enough. */
  private noteHealth(m: ManagedProcess): void {
    const backoff = this.backoffs.get(m.camera.id);
    if (!backoff || backoff.getAttempts() === 0) return;
    if (m.healthySince && Date.now() - m.healthySince.getTime() > env.HEALTHY_RESET_SECONDS * 1000) {
      backoff.reset();
      this.deps.logger.info({ cameraId: m.camera.id }, 'stream healthy; restart counter reset');
    }
  }

  private stopInternalAsync(cameraId: number, reason: string): Promise<void> {
    const m = this.processes.get(cameraId);
    if (!m) return Promise.resolve();
    this.deps.logger.info({ cameraId, reason }, 'stopping ffmpeg');
    m.intentionallyStopped = true;
    m.restartOnExit = false;
    this.clearTimers(m);
    return this.gracefulStop(cameraId);
  }

  /** Sends 'q' to FFmpeg stdin for a clean FLV flush, then SIGKILL on timeout. */
  private async gracefulStop(cameraId: number): Promise<void> {
    const m = this.processes.get(cameraId);
    if (!m) return;
    const child = m.child;
    try {
      child.stdin?.write('q');
    } catch {
      /* stdin closed */
    }
    const killed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          this.deps.logger.warn({ cameraId }, 'ffmpeg did not exit after SIGTERM, forcing SIGKILL');
          if (this.deps.killProcess) {
            this.deps.killProcess(child.pid!);
          } else {
            child.kill('SIGKILL');
          }
        }
        resolve(false);
      }, env.FFMPEG_KILL_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!killed) return;
  }

  private clearTimers(m: ManagedProcess): void {
    if (m.healthTimer) clearTimeout(m.healthTimer);
    if (m.killTimer) clearTimeout(m.killTimer);
    if (m.startTimer) clearTimeout(m.startTimer);
    m.healthTimer = null;
    m.killTimer = null;
    m.startTimer = null;
  }
}