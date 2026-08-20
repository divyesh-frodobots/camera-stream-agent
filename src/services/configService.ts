import type { AgentConfigCamera, AgentConfigResponse } from '../types/agentConfig';
import { configuredCameras, type StoredCamerasFile } from '../localMode/camerasFile';
import { maskRtmpUrl, maskUrl } from '../utils/mask';
import type { Logger } from '../utils/loggerTypes';
import type { AgentApi } from '../api/agentApi';
import { env } from '../config/env';

const LOCAL_CAMERA_ID = 1;

function rtmpParts(rtmpPublishUrl: string): { rtmpBaseUrl: string; streamKey: string } {
  const u = new URL(rtmpPublishUrl);
  const trimmedPath = u.pathname.replace(/\/+$/, '');
  const slash = trimmedPath.lastIndexOf('/');
  if (slash <= 0 || slash === trimmedPath.length - 1) {
    return { rtmpBaseUrl: rtmpPublishUrl.replace(/\/+$/, ''), streamKey: '' };
  }

  const streamKey = trimmedPath.slice(slash + 1);
  u.pathname = trimmedPath.slice(0, slash) || '/';
  return { rtmpBaseUrl: u.toString(), streamKey };
}

function resolveLocalVideoSettings(video?: Partial<LocalVideoSettings>): LocalVideoSettings {
  return {
    width: video?.width ?? DEFAULT_LOCAL_VIDEO.width,
    height: video?.height ?? DEFAULT_LOCAL_VIDEO.height,
    fps: video?.fps ?? DEFAULT_LOCAL_VIDEO.fps,
    bitrateKbps: video?.bitrateKbps ?? DEFAULT_LOCAL_VIDEO.bitrateKbps,
    transcodeEnabled: video?.transcodeEnabled ?? DEFAULT_LOCAL_VIDEO.transcodeEnabled,
    audioEnabled: video?.audioEnabled ?? DEFAULT_LOCAL_VIDEO.audioEnabled,
  };
}

export interface LocalVideoSettings {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  transcodeEnabled: boolean;
  audioEnabled: boolean;
}

const DEFAULT_LOCAL_VIDEO: LocalVideoSettings = {
  width: 1920,
  height: 1080,
  fps: 25,
  bitrateKbps: 3000,
  transcodeEnabled: true,
  audioEnabled: true,
};

function buildLocalVideoSettings(video: LocalVideoSettings) {
  return {
    codec: 'libx264',
    preset: 'veryfast',
    width: video.width,
    height: video.height,
    fps: video.fps,
    bitrateKbps: video.bitrateKbps,
    maxrateKbps: video.bitrateKbps,
    bufsizeKbps: video.bitrateKbps * 2,
    transcodeEnabled: video.transcodeEnabled,
    rtspTransport: 'tcp',
  };
}

export function buildLocalCamera(opts: {
  id: number;
  name: string;
  streamUrl: string;
  rtmpPublishUrl: string;
  uid?: string;
  channel?: string;
  video?: Partial<LocalVideoSettings>;
}): AgentConfigCamera {
  const { rtmpBaseUrl, streamKey } = rtmpParts(opts.rtmpPublishUrl);
  const video = resolveLocalVideoSettings(opts.video);
  return {
    id: opts.id,
    name: opts.name,
    rtspUrl: opts.streamUrl,
    channel: opts.channel ?? env.AGORA_CHANNEL,
    uid: opts.uid ?? String(1000 + opts.id),
    rtmpBaseUrl,
    streamKey,
    rtmpPublishUrl: opts.rtmpPublishUrl,
    streamKeyExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    video: buildLocalVideoSettings(video),
    audio: { enabled: video.audioEnabled, codec: 'aac', bitrateKbps: 160 },
  };
}

export function toAgentCameras(
  file: StoredCamerasFile,
  video?: Partial<LocalVideoSettings>,
): AgentConfigCamera[] {
  return configuredCameras(file).map((camera) =>
    buildLocalCamera({
      id: camera.id,
      name: camera.name,
      streamUrl: camera.rtspUrl,
      rtmpPublishUrl: camera.rtmpPublishUrl,
      video,
    }),
  );
}

/** Synthetic config used when STREAM_URL is set in the environment. */
export function buildLocalAgentConfig(opts: {
  streamUrl: string;
  rtmpPublishUrl: string;
  agentId: string;
  video?: Partial<LocalVideoSettings>;
}): AgentConfigResponse {
  return {
    agent: { id: opts.agentId, name: 'local', deviceId: 'local' },
    configVersion: 1,
    heartbeatIntervalSeconds: 15,
    cameras: [
      buildLocalCamera({
        id: LOCAL_CAMERA_ID,
        name: 'Local camera',
        streamUrl: opts.streamUrl,
        rtmpPublishUrl: opts.rtmpPublishUrl,
        uid: '1001',
        video: opts.video,
      }),
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
      localVideo?: Partial<LocalVideoSettings>;
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
      video: this.deps.localVideo ?? {
        width: env.LOCAL_VIDEO_WIDTH,
        height: env.LOCAL_VIDEO_HEIGHT,
        fps: env.LOCAL_VIDEO_FPS,
        bitrateKbps: env.LOCAL_VIDEO_BITRATE_KBPS,
        transcodeEnabled: env.LOCAL_VIDEO_TRANSCODE,
        audioEnabled: env.LOCAL_AUDIO_ENABLED,
      },
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
          { rtsp: maskUrl(next.cameras[0]!.rtspUrl), rtmp: maskRtmpUrl(next.cameras[0]!.rtmpPublishUrl) },
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