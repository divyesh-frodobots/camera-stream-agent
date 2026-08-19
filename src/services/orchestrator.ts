import { env } from '../config/env';
import type { AgentApi } from '../api/agentApi';
import type { CameraProcessManager } from '../ffmpeg/CameraProcessManager';
import type { ConfigDiff, ConfigService } from './configService';
import type { HeartbeatService } from './heartbeatService';
import type { ScreenshotService } from '../screenshots/screenshotService';
import type { Logger } from '../utils/loggerTypes';

/**
 * Applies backend configuration to the local FFmpeg processes:
 *  - starts new/added cameras
 *  - restarts only the cameras whose configuration changed
 *  - stops cameras that were removed/disabled
 *  - never touches healthy processes when the backend is unreachable
 */
export class Orchestrator {
  private configTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      api: AgentApi;
      configService: ConfigService;
      processManager: CameraProcessManager;
      screenshotService: ScreenshotService;
      heartbeatService: HeartbeatService;
      logger: Logger;
    },
  ) {}

  async applyDiff(diff: ConfigDiff | null): Promise<void> {
    if (!diff) return;

    for (const cam of diff.removed) {
      this.deps.logger.info({ cameraId: cam.id, cameraName: cam.name }, 'camera removed from config; stopping');
      await this.deps.processManager.forget(cam.id, 'camera removed from config');
      await this.deps.screenshotService.stop(cam.id);
    }

    for (const cam of diff.changed) {
      this.deps.logger.info(
        { cameraId: cam.id, cameraName: cam.name },
        'camera configuration changed; restarting stream',
      );
      await this.deps.processManager.start(cam);
      await this.deps.screenshotService.start(cam);
    }

    for (const cam of diff.added) {
      this.deps.logger.info({ cameraId: cam.id, cameraName: cam.name }, 'camera added; starting stream');
      await this.deps.processManager.start(cam);
      await this.deps.screenshotService.start(cam);
    }
  }

  /**
   * Initial bootstrap. Retries until the backend responds, so the agent can
   * start before the backend or network is available. Existing FFmpeg
   * processes are NOT stopped while waiting.
   */
  async bootstrap(): Promise<void> {
    this.deps.logger.info({ backend: 'configured' }, 'agent starting; fetching configuration');
    for (;;) {
      const diff = await this.deps.configService.refresh();
      if (diff) {
        await this.applyDiff(diff);
        return;
      }
      await new Promise((r) => setTimeout(r, env.HTTP_RETRY_MAX_MS));
    }
  }

  startLoops(): void {
    if (!this.deps.configService.usesLocalStream()) {
      const refreshInterval = Math.max(5, env.CONFIG_REFRESH_SECONDS) * 1000;
      this.configTimer = setInterval(() => {
        void this.deps.configService
          .refresh()
          .then((diff) => this.applyDiff(diff))
          .catch((err) => {
            this.deps.logger.error(
              { err: err instanceof Error ? err.message : err },
              'config refresh cycle failed',
            );
          });
      }, refreshInterval);
    }

    if (env.AGENT_API_KEY) {
      const heartbeatInterval = Math.max(5, env.HEARTBEAT_INTERVAL_SECONDS) * 1000;
      this.heartbeatTimer = setInterval(() => {
        void this.deps.heartbeatService.send();
      }, heartbeatInterval);
    }
  }

  async shutdown(): Promise<void> {
    this.deps.logger.info('shutting down agent');
    if (this.configTimer) clearInterval(this.configTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.configTimer = null;
    this.heartbeatTimer = null;
    await this.deps.screenshotService.stopAll();
    await this.deps.processManager.stopAll();
    this.deps.logger.info('agent stopped');
  }
}