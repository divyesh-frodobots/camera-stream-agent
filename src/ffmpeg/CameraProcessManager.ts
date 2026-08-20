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
  // resolves once this child's close handler has finished supervision
  closeSettled: Promise<void>;
  resolveClose: () => void;
}

const LOG_RING_SIZE = 50;

export class ProcessTerminationError extends Error {
  constructor(
    readonly cameraId: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessTerminationError';
  }
}

export class StopAllIncompleteError extends Error {
  constructor(
    readonly stuckCameraIds: number[],
    readonly failures: Array<{ cameraId: number; error: unknown }>,
  ) {
    super(`stopAll incomplete: ${stuckCameraIds.length} process(es) could not be terminated`);
    this.name = 'StopAllIncompleteError';
  }
}

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
  // serializes start/stop/forget/forceRestart per camera in invocation order
  private readonly lifecycleQueues = new Map<number, Promise<void>>();
  private shuttingDown = false;

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
    return this.enqueueLifecycle(camera.id, () => this.startInternal(camera));
  }

  /**
   * Stops any running child (and cancels a pending auto-restart), resets
   * backoff for this camera, and spawns the supplied config exactly once.
   * Concurrent calls for the same camera are serialized; the last call wins.
   */
  async forceRestart(camera: AgentConfigCamera): Promise<void> {
    return this.enqueueLifecycle(camera.id, () => this.forceRestartInternal(camera));
  }

  /** Stops the camera process without scheduling a restart. */
  async stop(cameraId: number, reason = 'stopped'): Promise<void> {
    return this.enqueueLifecycle(cameraId, () => this.stopInternal(cameraId, reason));
  }

  /**
   * Stops the camera and forgets it entirely: it will no longer be reported
   * in status/heartbeats. Used when the camera is removed from the config.
   */
  async forget(cameraId: number, reason = 'camera removed'): Promise<void> {
    return this.enqueueLifecycle(cameraId, () => this.forgetInternal(cameraId, reason));
  }

  /** Stops all processes (shutdown). */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    this.cancelAllRestarts();

    const failures: Array<{ cameraId: number; error: unknown }> = [];

    if (this.lifecycleQueues.size > 0) {
      const queueEntries = [...this.lifecycleQueues.entries()];
      const queueResults = await Promise.allSettled(queueEntries.map(([, promise]) => promise));
      for (let i = 0; i < queueResults.length; i++) {
        const result = queueResults[i]!;
        if (result.status === 'rejected') {
          failures.push({ cameraId: queueEntries[i]![0], error: result.reason });
        }
      }
    }

    if (this.processes.size > 0) {
      const ids = [...this.processes.keys()];
      const stopResults = await Promise.allSettled(ids.map((id) => this.stopOneForShutdown(id)));
      for (let i = 0; i < stopResults.length; i++) {
        const result = stopResults[i]!;
        if (result.status === 'rejected') {
          failures.push({ cameraId: ids[i]!, error: result.reason });
        }
      }
    }

    if (failures.length > 0 || this.processes.size > 0) {
      throw new StopAllIncompleteError([...this.processes.keys()], failures);
    }

    this.knownCameras.clear();
    this.backoffs.clear();
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

  private enqueueLifecycle(cameraId: number, op: () => Promise<void>): Promise<void> {
    const previous = this.lifecycleQueues.get(cameraId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => op());
    this.lifecycleQueues.set(cameraId, run);
    return run.finally(() => {
      if (this.lifecycleQueues.get(cameraId) === run) {
        this.lifecycleQueues.delete(cameraId);
      }
    });
  }

  private async startInternal(camera: AgentConfigCamera): Promise<void> {
    if (this.shuttingDown) return;
    const existing = this.processes.get(camera.id);
    if (existing && !existing.child.killed && existing.child.exitCode === null && !existing.intentionallyStopped) {
      this.deps.logger.debug({ cameraId: camera.id }, 'process already running, skipping start');
      return;
    }
    if (existing) {
      await this.stopProcessAsync(camera.id, 'configuration changed; restarting');
    }
    this.spawnProcess(camera);
  }

  private async forceRestartInternal(camera: AgentConfigCamera): Promise<void> {
    if (this.shuttingDown) return;
    this.cancelRestart(camera.id);
    await this.stopProcessAsync(camera.id, 'force restart');
    const backoff = this.backoffs.get(camera.id);
    if (backoff) {
      backoff.reset();
    } else {
      this.backoffs.delete(camera.id);
    }
    this.spawnProcess(camera);
  }

  private async stopInternal(cameraId: number, reason: string): Promise<void> {
    this.cancelRestart(cameraId);
    await this.stopProcessAsync(cameraId, reason);
    this.backoffs.delete(cameraId);
  }

  private async forgetInternal(cameraId: number, reason: string): Promise<void> {
    await this.stopInternal(cameraId, reason);
    this.knownCameras.delete(cameraId);
  }

  private async stopOneForShutdown(cameraId: number): Promise<void> {
    const m = this.processes.get(cameraId);
    if (!m) return;
    m.intentionallyStopped = true;
    m.restartOnExit = false;
    this.clearTimers(m);
    await this.gracefulStop(cameraId);
  }

  private spawnProcess(camera: AgentConfigCamera): void {
    if (this.shuttingDown) {
      this.deps.logger.info({ cameraId: camera.id }, 'shutdown in progress; skipping ffmpeg spawn');
      return;
    }

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

    let resolveClose!: () => void;
    const closeSettled = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

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
      closeSettled,
      resolveClose,
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
      try {
        this.onProcessExit(camera.id, child, code, signal);
      } finally {
        resolveClose();
      }
    });
  }

  private onProcessExit(
    cameraId: number,
    child: ChildProcess,
    code: number | null,
    signal: string | null,
  ): void {
    const m = this.processes.get(cameraId);
    if (!m || m.child !== child) return;
    this.clearTimers(m);
    this.processes.delete(cameraId);
    const wasHealthy = m.lastHealthyAt !== null;

    this.deps.logger.info(
      { cameraId, cameraName: m.camera.name, code, signal, intentionallyStopped: m.intentionallyStopped },
      'ffmpeg exited',
    );

    if (!m.lastError && !m.intentionallyStopped && m.recentLog.length > 0) {
      this.deps.logger.warn(
        { cameraId, cameraName: m.camera.name, code, recentLog: m.recentLog.slice(-12) },
        'ffmpeg exited without a classified error line',
      );
    }

    if (m.intentionallyStopped && !m.restartOnExit) {
      this.emitStateChange(this.getState(cameraId)!);
      return;
    }

    if (this.shuttingDown) {
      this.emitStateChange(this.getState(cameraId)!);
      return;
    }

    // Crash, network loss, or a health-kill: restart with backoff.
    const reason = m.lastError ?? (signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
    this.scheduleRestart(m.camera, reason, wasHealthy);
  }

  private scheduleRestart(camera: AgentConfigCamera, reason: string, wasHealthy = false): void {
    if (this.shuttingDown) return;
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
      if (this.shuttingDown) return;
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

  private cancelAllRestarts(): void {
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
  }

  private checkHealth(cameraId: number): void {
    const m = this.processes.get(cameraId);
    if (!m || m.intentionallyStopped || this.shuttingDown) return;
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
      this.gracefulStopFireAndForget(cameraId, 'health timeout');
      return;
    }
    const timer = setTimeout(() => this.checkHealth(cameraId), env.FFMPEG_HEALTH_TIMEOUT_SECONDS * 1000);
    timer.unref?.();
    m.healthTimer = timer;
  }

  /** Kills a process that never produced its first frame within the startup timeout. */
  private checkStartTimeout(cameraId: number): void {
    const m = this.processes.get(cameraId);
    if (!m || m.intentionallyStopped || this.shuttingDown) return;
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
    this.gracefulStopFireAndForget(cameraId, 'start timeout');
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

  private stopProcessAsync(cameraId: number, reason: string): Promise<void> {
    const m = this.processes.get(cameraId);
    if (!m) return Promise.resolve();
    this.deps.logger.info({ cameraId, reason }, 'stopping ffmpeg');
    m.intentionallyStopped = true;
    m.restartOnExit = false;
    this.clearTimers(m);
    return this.gracefulStop(cameraId);
  }

  private gracefulStopFireAndForget(cameraId: number, context: string): void {
    void this.gracefulStop(cameraId).catch((err: unknown) => {
      if (err instanceof ProcessTerminationError) {
        this.deps.logger.error(
          { cameraId, context, err: err.message },
          'ffmpeg graceful stop failed; process remains tracked in ERROR',
        );
        return;
      }
      this.deps.logger.error(
        { cameraId, context, err: err instanceof Error ? err.message : err },
        'unexpected error during ffmpeg graceful stop',
      );
    });
  }

  /** Sends 'q' to FFmpeg stdin for a clean FLV flush, then SIGKILL on timeout. */
  private async gracefulStop(cameraId: number): Promise<void> {
    const m = this.processes.get(cameraId);
    if (!m) return;
    const { child, closeSettled } = m;
    let closed = false;
    void closeSettled.then(() => {
      closed = true;
    });

    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin?.write('q');
      } catch {
        /* stdin closed */
      }

      await Promise.race([closeSettled, this.delay(env.FFMPEG_KILL_TIMEOUT_MS)]);

      if (!closed && child.exitCode === null && child.signalCode === null) {
        this.deps.logger.warn({ cameraId }, 'ffmpeg did not exit gracefully, forcing SIGKILL');
        if (this.deps.killProcess) {
          this.deps.killProcess(child.pid!);
        } else {
          child.kill('SIGKILL');
        }
        await Promise.race([closeSettled, this.delay(env.FFMPEG_KILL_TIMEOUT_MS)]);
      }
    } else {
      await Promise.race([closeSettled, this.delay(env.FFMPEG_KILL_TIMEOUT_MS)]);
    }

    if (closed) return;

    if (this.isTerminationConfirmed(child)) {
      this.deps.logger.warn(
        { cameraId, pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode },
        'ffmpeg close never arrived but termination is confirmed; finalizing cleanup',
      );
      this.finalizeWithoutCloseEvent(cameraId, child);
      return;
    }

    this.deps.logger.error(
      { cameraId, pid: child.pid ?? null },
      'ffmpeg termination unconfirmed after forced kill',
    );
    this.markUnconfirmedTerminationError(cameraId, child);
    throw new ProcessTerminationError(cameraId, 'ffmpeg termination unconfirmed after forced kill');
  }

  private isTerminationConfirmed(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private finalizeWithoutCloseEvent(cameraId: number, child: ChildProcess): void {
    const m = this.processes.get(cameraId);
    if (!m || m.child !== child) return;
    this.clearTimers(m);
    this.processes.delete(cameraId);
    this.emitStateChange(this.getState(cameraId)!);
    m.resolveClose();
  }

  private markUnconfirmedTerminationError(cameraId: number, child: ChildProcess): void {
    const m = this.processes.get(cameraId);
    if (!m || m.child !== child) return;
    this.clearTimers(m);
    m.status = 'ERROR';
    m.lastError = 'ffmpeg termination unconfirmed after forced kill';
    m.lastErrorCategory = 'generic';
    m.intentionallyStopped = true;
    m.restartOnExit = false;
    this.emitStateChange(this.getState(cameraId)!);
    // Do not resolve closeSettled: close is not confirmed; a later lifecycle op
    // performs a fresh bounded termination attempt and waits for real close/exit.
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
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
