import { describe, it, expect, vi } from 'vitest';
import {
  ConfigService,
  buildLocalAgentConfig,
  buildLocalCamera,
  cameraSignature,
  diffConfig,
  toAgentCameras,
} from '../src/services/configService';
import { emptyCamerasFile } from '../src/localMode/camerasFile';
import { buildFfmpegArgs } from '../src/ffmpeg/ffmpegArgs';
import type { AgentConfigCamera, AgentConfigResponse } from '../src/types/agentConfig';
import { env } from '../src/config/env';
import { silentLogger } from './helpers/fakes';

function makeCamera(id: number, overrides: Partial<AgentConfigCamera> = {}): AgentConfigCamera {
  return {
    id,
    name: `Camera ${id}`,
    rtspUrl: `rtsp://cam${id}:554/stream`,
    channel: `offroad_cam_${id}`,
    uid: `${1000 + id}`,
    rtmpBaseUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live',
    streamKey: `sk-${id}`,
    rtmpPublishUrl: `rtmp://rtls-ingress-prod-ap.agoramdn.com/live/sk-${id}`,
    streamKeyExpiresAt: new Date().toISOString(),
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
    ...overrides,
  };
}

function makeConfig(cameras: AgentConfigCamera[], configVersion = 1): AgentConfigResponse {
  return {
    agent: { id: 'agent-1', name: 'PC', deviceId: 'dev-1' },
    configVersion,
    heartbeatIntervalSeconds: 15,
    cameras,
  };
}

const api = {
  fetchConfig: async () => makeConfig([]),
  sendHeartbeat: async () => {},
  uploadScreenshot: async () => {},
} as never;

describe('buildLocalCamera', () => {
  it('uses id-based default uid and applies video overrides', () => {
    const cam = buildLocalCamera({
      id: 3,
      name: 'Pit',
      streamUrl: 'rtsp://cam/live',
      rtmpPublishUrl: 'rtmp://x/live/key3',
      video: { width: 640, height: 480, fps: 15, bitrateKbps: 800 },
    });

    expect(cam.id).toBe(3);
    expect(cam.name).toBe('Pit');
    expect(cam.uid).toBe('1003');
    expect(cam.rtspUrl).toBe('rtsp://cam/live');
    expect(cam.rtmpPublishUrl).toBe('rtmp://x/live/key3');
    expect(cam.streamKey).toBe('key3');
    expect(cam.video).toMatchObject({
      width: 640,
      height: 480,
      fps: 15,
      bitrateKbps: 800,
      maxrateKbps: 800,
      bufsizeKbps: 1600,
      transcodeEnabled: true,
    });
    expect(cam.audio.enabled).toBe(true);
    expect(cam.channel).toBe(env.AGORA_CHANNEL);
  });

  it('uses an explicit channel when provided', () => {
    const cam = buildLocalCamera({
      id: 1,
      name: 'Test',
      streamUrl: 'rtsp://cam/live',
      rtmpPublishUrl: 'rtmp://x/live/k',
      channel: 'custom_channel',
    });
    expect(cam.channel).toBe('custom_channel');
  });

  it('preserves defaults when video override fields are explicitly undefined', () => {
    const cam = buildLocalCamera({
      id: 1,
      name: 'Test',
      streamUrl: 'rtsp://cam/live',
      rtmpPublishUrl: 'rtmp://x/live/k',
      video: {
        width: undefined,
        height: undefined,
        fps: 15,
        bitrateKbps: undefined,
        transcodeEnabled: undefined,
        audioEnabled: undefined,
      },
    });

    expect(cam.video).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 15,
      bitrateKbps: 3000,
      maxrateKbps: 3000,
      bufsizeKbps: 6000,
      transcodeEnabled: true,
    });
    expect(cam.audio.enabled).toBe(true);
  });

  it('splits RTMP publish URLs using URL path semantics', () => {
    const cam = buildLocalCamera({
      id: 1,
      name: 'Test',
      streamUrl: 'rtsp://cam/live',
      rtmpPublishUrl: 'rtmp://host/live/my-key?token=abc',
    });

    expect(cam.streamKey).toBe('my-key');
    expect(cam.rtmpBaseUrl).toBe('rtmp://host/live?token=abc');
    expect(cam.rtmpPublishUrl).toBe('rtmp://host/live/my-key?token=abc');
  });
});

describe('toAgentCameras', () => {
  it('maps six configured rows to AgentConfigCamera with ids 1-6 and uids 1001-1006', () => {
    const file = emptyCamerasFile();
    for (let id = 1; id <= 6; id++) {
      file.cameras[id - 1] = {
        id,
        name: `Cam ${id}`,
        rtspUrl: `rtsp://cam/${id}`,
        rtmpPublishUrl: `rtmp://x/live/k${id}`,
        enabled: id % 2 === 0,
      };
    }

    const cameras = toAgentCameras(file, { width: 1280, height: 720, fps: 30, bitrateKbps: 2000 });

    expect(cameras).toHaveLength(6);
    expect(cameras.map((c) => ({ id: c.id, uid: c.uid, name: c.name }))).toEqual([
      { id: 1, uid: '1001', name: 'Cam 1' },
      { id: 2, uid: '1002', name: 'Cam 2' },
      { id: 3, uid: '1003', name: 'Cam 3' },
      { id: 4, uid: '1004', name: 'Cam 4' },
      { id: 5, uid: '1005', name: 'Cam 5' },
      { id: 6, uid: '1006', name: 'Cam 6' },
    ]);
    expect(cameras[0]!.video).toMatchObject({
      width: 1280,
      height: 720,
      fps: 30,
      bitrateKbps: 2000,
      maxrateKbps: 2000,
      bufsizeKbps: 4000,
    });
    expect(cameras.every((c) => c.channel === env.AGORA_CHANNEL)).toBe(true);
  });

  it('skips unconfigured rows', () => {
    const file = emptyCamerasFile();
    file.cameras[0] = {
      id: 1,
      name: 'Only',
      rtspUrl: 'rtsp://cam/1',
      rtmpPublishUrl: 'rtmp://x/live/k1',
      enabled: true,
    };

    expect(toAgentCameras(file)).toHaveLength(1);
    expect(toAgentCameras(file)[0]!.id).toBe(1);
  });
});

describe('buildLocalAgentConfig', () => {
  it('builds a single local camera with id 1, name Local camera, uid 1001', () => {
    const config = buildLocalAgentConfig({
      streamUrl: 'rtsp://cam:554/stream',
      rtmpPublishUrl: 'rtmp://example.com/live/sk',
      agentId: 'local-agent',
    });

    expect(config.cameras).toHaveLength(1);
    expect(config.cameras[0]).toMatchObject({
      id: 1,
      name: 'Local camera',
      uid: '1001',
      channel: env.AGORA_CHANNEL,
      rtspUrl: 'rtsp://cam:554/stream',
      rtmpPublishUrl: 'rtmp://example.com/live/sk',
    });
  });
});

describe('cameraSignature / diffConfig', () => {
  it('detects added, removed, changed and unchanged cameras', () => {
    const prev = makeConfig([makeCamera(1), makeCamera(2)]);
    const next = makeConfig(
      [makeCamera(1), makeCamera(2, { streamKey: 'sk-new' }) /* changed */, makeCamera(3) /* added */],
      2,
    );
    const diff = diffConfig(prev, next);
    expect(diff.added.map((c) => c.id)).toEqual([3]);
    expect(diff.changed.map((c) => c.id)).toEqual([2]);
    expect(diff.removed.map((c) => c.id)).toEqual([]);
    expect(diff.unchanged.map((c) => c.id)).toEqual([1]);
  });

  it('detects removed cameras when they disappear', () => {
    const prev = makeConfig([makeCamera(1), makeCamera(2)]);
    const next = makeConfig([makeCamera(1)]);
    const diff = diffConfig(prev, next);
    expect(diff.removed.map((c) => c.id)).toEqual([2]);
  });

  it('signature changes when a stream key rotates but not on unrelated fields', () => {
    const base = makeCamera(1);
    const rotatedKey = makeCamera(1, { streamKey: 'sk-rotated', rtmpPublishUrl: '.../sk-rotated' });
    expect(cameraSignature(base)).not.toBe(cameraSignature(rotatedKey));

    const renamed = makeCamera(1, { name: 'Renamed' });
    expect(cameraSignature(base)).toBe(cameraSignature(renamed)); // name does not affect streaming
  });

  it('config service reports diffs only on change', async () => {
    let version = 1;
    const cfgApi = {
      fetchConfig: async () => makeConfig([makeCamera(1)], version),
    } as never;
    const service = new ConfigService({ api: cfgApi, logger: silentLogger });

    const first = await service.refresh();
    expect(first!.added).toHaveLength(1);
    expect(service.getAgentId()).toBe('agent-1');

    const same = await service.refresh();
    expect(same!.added).toHaveLength(0);
    expect(same!.changed).toHaveLength(0);

    version = 2;
    const changed = await service.refresh();
    expect(changed!.configVersion).toBe(2);
  });

  it('returns null and keeps state when the backend is unreachable', async () => {
    const failing = {
      fetchConfig: async () => {
        throw new Error('network down');
      },
    } as never;
    const service = new ConfigService({ api: failing, logger: silentLogger });
    const diff = await service.refresh();
    expect(diff).toBeNull();
    expect(service.getCurrentConfig()).toBeNull();
  });

  it('uses STREAM_URL from env and never calls the backend config API', async () => {
    const fetchConfig = vi.fn(async () => makeConfig([makeCamera(1)]));
    const service = new ConfigService({
      api: { fetchConfig } as never,
      logger: silentLogger,
      fallbackAgentId: 'local-agent',
      localStreamUrl: 'rtsp://user:pass@192.168.1.64:554/stream1',
      localRtmpPublishUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live/sk-local',
    });

    const diff = await service.refresh();

    expect(fetchConfig).not.toHaveBeenCalled();
    expect(diff!.added).toHaveLength(1);
    expect(diff!.added[0]!.rtspUrl).toBe('rtsp://user:pass@192.168.1.64:554/stream1');
    expect(diff!.added[0]!.rtmpPublishUrl).toBe('rtmp://rtls-ingress-prod-ap.agoramdn.com/live/sk-local');
    expect(diff!.added[0]!.streamKey).toBe('sk-local');
    expect(service.getAgentId()).toBe('local-agent');
    expect(service.usesLocalStream()).toBe(true);
  });

  it('masks RTMP publish URL in local stream startup log', async () => {
    const info = vi.fn();
    const service = new ConfigService({
      api: { fetchConfig: vi.fn() } as never,
      logger: { ...silentLogger, info },
      localStreamUrl: 'rtsp://user:pass@192.168.1.64:554/stream1',
      localRtmpPublishUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live/SECRET_KEY_12345',
    });

    await service.refresh();

    expect(info).toHaveBeenCalled();
    const payload = info.mock.calls[0]![0] as { rtsp: string; rtmp: string };
    expect(payload.rtmp).not.toContain('SECRET_KEY_12345');
    expect(payload.rtmp).toMatch(/\*\*\*/);
  });

  it('defaults the local camera to 1080p25 transcoding with audio', async () => {
    const config = buildLocalAgentConfig({
      streamUrl: 'rtsp://cam:554/stream',
      rtmpPublishUrl: 'rtmp://example.com/live/sk',
      agentId: 'local-agent',
    });

    expect(config.cameras[0]!.video).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 25,
      bitrateKbps: 3000,
      maxrateKbps: 3000,
      bufsizeKbps: 6000,
      transcodeEnabled: true,
    });
    expect(config.cameras[0]!.audio.enabled).toBe(true);
  });

  it('applies local video overrides and derives maxrate and bufsize from the bitrate', async () => {
    const config = buildLocalAgentConfig({
      streamUrl: 'rtsp://cam:554/stream',
      rtmpPublishUrl: 'rtmp://example.com/live/sk',
      agentId: 'local-agent',
      video: { width: 640, height: 480, fps: 15, bitrateKbps: 800, audioEnabled: false },
    });

    expect(config.cameras[0]!.video).toMatchObject({
      width: 640,
      height: 480,
      fps: 15,
      bitrateKbps: 800,
      maxrateKbps: 800,
      bufsizeKbps: 1600,
      transcodeEnabled: true,
    });
    expect(config.cameras[0]!.audio.enabled).toBe(false);
  });

  it('passes local video overrides through the service to FFmpeg args', async () => {
    const service = new ConfigService({
      api: { fetchConfig: vi.fn() } as never,
      logger: silentLogger,
      localStreamUrl: 'rtsp://cam:554/stream',
      localRtmpPublishUrl: 'rtmp://example.com/live/sk',
      localVideo: { width: 640, height: 480, fps: 15, bitrateKbps: 800, audioEnabled: false },
    });

    const diff = await service.refresh();
    const args = buildFfmpegArgs(diff!.added[0]!);

    expect(args).toContain('640x480');
    expect(args).toContain('800k');
    expect(args).toContain('-an');
    expect(args[args.indexOf('-r') + 1]).toBe('15');
    // 2s keyframe interval at the overridden fps
    expect(args[args.indexOf('-g') + 1]).toBe('30');
  });

  it('remuxes without re-encoding when local transcoding is disabled', async () => {
    const service = new ConfigService({
      api: { fetchConfig: vi.fn() } as never,
      logger: silentLogger,
      localStreamUrl: 'rtsp://cam:554/stream',
      localRtmpPublishUrl: 'rtmp://example.com/live/sk',
      localVideo: { transcodeEnabled: false },
    });

    const diff = await service.refresh();
    const args = buildFfmpegArgs(diff!.added[0]!);

    expect(args.join(' ')).toContain('-c:v copy');
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('-s');
  });

  it('does not treat a later local refresh as a camera change', async () => {
    const fetchConfig = vi.fn(async () => makeConfig([]));
    const service = new ConfigService({
      api: { fetchConfig } as never,
      logger: silentLogger,
      localStreamUrl: 'rtsp://cam:554/stream',
      localRtmpPublishUrl: 'rtmp://example.com/live/sk',
    });

    await service.refresh();
    const second = await service.refresh();

    expect(fetchConfig).not.toHaveBeenCalled();
    expect(second!.added).toHaveLength(0);
    expect(second!.changed).toHaveLength(0);
    expect(second!.removed).toHaveLength(0);
  });
});