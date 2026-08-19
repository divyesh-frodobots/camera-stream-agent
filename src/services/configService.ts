import type { AgentConfigCamera, AgentConfigResponse } from '../types/agentConfig';
import { maskUrl } from '../utils/mask';
import type { Logger } from '../utils/loggerTypes';
import type { AgentApi } from '../api/agentApi';

const LOCAL_CAMERA_ID = 1;

function rtmpParts(rtmpPublishUrl: string): { rtmpBaseUrl: string; streamKey: string } {
  const trimmed = rtmpPublishUrl.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { rtmpBaseUrl: trimmed, streamKey: '' };
  }
  return { rtmpBaseUrl: trimmed.slice(0, slash), streamKey: trimmed.slice(slash + 1) };
}

/** Synthetic config used when STREAM_URL is set in the environment. */
export function buildLocalAgentConfig(opts: {
  streamUrl: string;
  rtmpPublishUrl: string;
  agentId: string;
}): AgentConfigResponse {
  const { rtmpBaseUrl, streamKey } = rtmpParts(opts.rtmpPublishUrl);
  return {
    agent: { id: opts.agentId, name: 'local', deviceId: 'local' },
    configVersion: 1,
    heartbeatIntervalSeconds: 15,
    cameras: [
      {
        id: LOCAL_CAMERA_ID,
        name: 'Local camera',
        rtspUrl: opts.streamUrl,
        channel: 'local',
        uid: '1001',
        rtmpBaseUrl,
        streamKey,
        rtmpPublishUrl: opts.rtmpPublishUrl,
        streamKeyExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        video: {
          codec: 'libx264',
          preset: 'veryfast',
          width: 1920,
          height: 1080,
          fps: 25,
          bitrateKbps: 3000,
          maxrateKbps: 3000,
          bufsizeKbps: 6000,
          transcodeEnabled: true,
          rtspTransport: 'tcp',
        },
        audio: { enabled: true, codec: 'aac', bitrateKbps: 160 },
      },
    ],
  };
}

export interface ConfigDiff {
  added: AgentConfigCamera[];
  removed: AgentConfigCamera[];
  changed: AgentConfigCamera[];
  unchanged: AgentConfigCamera[];
  configVersion: number;
}

/**
 * Builds a stable signature of the agent-relevant camera configuration. Any
 * change (RTSP url, resolution, bitrate, stream key, RTMP url, ...) results
 * in a different signature so only the affected camera is restarted.
 */
export function cameraSignature(camera: AgentConfigCamera): string {
  const parts = [
    camera.rtspUrl,
    camera.streamKey,
    camera.rtmpPublishUrl,
    camera.video.codec,
    camera.video.preset,
    camera.video.width,
    camera.video.height,
    camera.video.fps,
    camera.video.bitrateKbps,
    camera.video.maxrateKbps,
    camera.video.bufsizeKbps,
    camera.video.transcodeEnabled,
    camera.video.rtspTransport,
    camera.audio.enabled,
    camera.audio.codec,
    camera.audio.bitrateKbps,
  ];
  return parts.join('|');
}

export function diffConfig(current: AgentConfigResponse, next: AgentConfigResponse): ConfigDiff {
  const currentByCamera = new Map(current.cameras.map((c) => [c.id, c]));
  const nextByCamera = new Map(next.cameras.map((c) => [c.id, c]));

  const added: AgentConfigCamera[] = [];
  const removed: AgentConfigCamera[] = [];
  const changed: AgentConfigCamera[] = [];
  const unchanged: AgentConfigCamera[] = [];

  for (const cam of next.cameras) {
    const prev = currentByCamera.get(cam.id);
    if (!prev) {
      added.push(cam);
    } else if (cameraSignature(prev) !== cameraSignature(cam)) {
      changed.push(cam);
    } else {
      unchanged.push(cam);
    }
  }

  for (const cam of current.cameras) {
    if (!nextByCamera.has(cam.id)) removed.push(cam);
  }

  return { added, removed, changed, unchanged, configVersion: next.configVersion };
}

/**
 * Polls the backend for the agent configuration and reports changes so the
 * orchestrator can restart only the affected cameras.
 */
export class ConfigService {
  private current: AgentConfigResponse | null = null;

  constructor(
    private readonly deps: {
      api: AgentApi;
      logger: Logger;
      fallbackAgentId?: string;
      localStreamUrl?: string;
      localRtmpPublishUrl?: string;
    },
  ) {}

  getCurrentConfig(): AgentConfigResponse | null {
    return this.current;
  }

  getAgentId(): string | null {
    return this.current?.agent.id ?? this.deps.fallbackAgentId ?? null;
  }

  usesLocalStream(): boolean {
    return Boolean(this.deps.localStreamUrl);
  }

  private localConfig(): AgentConfigResponse {
    const streamUrl = this.deps.localStreamUrl;
    const rtmpPublishUrl = this.deps.localRtmpPublishUrl;
    if (!streamUrl || !rtmpPublishUrl) {
      throw new Error('RTMP_PUBLISH_URL is required when STREAM_URL is set');
    }
    return buildLocalAgentConfig({
      streamUrl,
      rtmpPublishUrl,
      agentId: this.deps.fallbackAgentId || 'local-agent',
    });
  }

  /**
   * Fetches the latest config. Returns the diff (or null when the fetch
   * failed and no previous config exists). Never throws.
   * When STREAM_URL is set, returns a local synthetic config and does not
   * call the backend.
   */
  async refresh(): Promise<ConfigDiff | null> {
    let next: AgentConfigResponse;
    if (this.usesLocalStream()) {
      next = this.localConfig();
      if (!this.current) {
        this.deps.logger.info(
          { rtsp: maskUrl(next.cameras[0]!.rtspUrl), rtmp: maskUrl(next.cameras[0]!.rtmpPublishUrl) },
          'using STREAM_URL from env; skipping backend config API',
        );
      }
    } else {
      try {
        next = await this.deps.api.fetchConfig();
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : err },
          'config fetch failed; keeping current config (streams continue)',
        );
        return null;
      }
    }

    const previous = this.current;
    this.current = next;

    const diff = diffConfig(
      previous ?? { agent: next.agent, configVersion: 0, cameras: [], heartbeatIntervalSeconds: next.heartbeatIntervalSeconds },
      next,
    );
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      this.deps.logger.info(
        {
          configVersion: diff.configVersion,
          added: diff.added.map((c) => c.id),
          removed: diff.removed.map((c) => c.id),
          changed: diff.changed.map((c) => c.id),
        },
        'configuration changed',
      );
    }
    for (const cam of [...diff.added, ...diff.changed]) {
      this.deps.logger.info({ cameraId: cam.id, cameraName: cam.name, rtsp: maskUrl(cam.rtspUrl) }, 'camera config');
    }
    return diff;
  }
}