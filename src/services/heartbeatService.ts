import type { AgentApi } from '../api/agentApi';
import type { CameraProcessManager } from '../ffmpeg/CameraProcessManager';
import type { CameraRuntimeStatus, HeartbeatCameraState } from '../types/agentConfig';
import type { Logger } from '../utils/loggerTypes';

export interface HeartbeatServiceOptions {
  api: AgentApi;
  processManager: CameraProcessManager;
  logger: Logger;
  version: string;
  getAgentId: () => string | null;
  cameraStatusProvider?: () => HeartbeatCameraState[];
}

/**
 * Periodically reports per-camera status to the backend. Failures are logged
 * and retried by the API client's backoff; a temporarily unreachable backend
 * never stops the local FFmpeg processes.
 */
export class HeartbeatService {
  constructor(private readonly deps: HeartbeatServiceOptions) {}

  buildPayload(): HeartbeatCameraState[] {
    if (this.deps.cameraStatusProvider) return this.deps.cameraStatusProvider();
    return this.deps.processManager.getAllStates().map((s) => ({
      cameraId: s.cameraId,
      status: s.status as CameraRuntimeStatus,
      pid: s.pid ?? undefined,
      uptime: s.uptime,
      restartCount: s.restartCount,
    }));
  }

  async send(): Promise<void> {
    const agentId = this.deps.getAgentId();
    if (!agentId) {
      this.deps.logger.warn('cannot send heartbeat: agent id unknown yet');
      return;
    }
    const payload = {
      agentId,
      version: this.deps.version,
      cameras: this.buildPayload(),
    };
    try {
      await this.deps.api.sendHeartbeat(payload);
      this.deps.logger.debug({ cameras: payload.cameras.length }, 'heartbeat sent');
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'heartbeat failed (will retry on next cycle)',
      );
    }
  }
}