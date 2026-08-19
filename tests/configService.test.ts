import { describe, it, expect, vi } from 'vitest';
import { ConfigService, cameraSignature, diffConfig } from '../src/services/configService';
import type { AgentConfigCamera, AgentConfigResponse } from '../src/types/agentConfig';
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