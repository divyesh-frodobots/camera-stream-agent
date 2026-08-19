import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Orchestrator } from '../src/services/orchestrator';
import { env } from '../src/config/env';
import type { AgentConfigCamera } from '../src/types/agentConfig';
import { silentLogger } from './helpers/fakes';
import type { ConfigDiff } from '../src/services/configService';

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

function makeDiff(overrides: Partial<ConfigDiff> = {}): ConfigDiff {
  return {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    configVersion: 2,
    ...overrides,
  };
}

function setup() {
  const processManager = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    getAllStates: vi.fn(() => []),
  };
  const screenshotService = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
  };
  const heartbeatService = { send: vi.fn(async () => {}) };
  const configService = {
    refresh: vi.fn(async () => null as ConfigDiff | null),
    getAgentId: vi.fn(() => 'agent-1'),
    getCurrentConfig: vi.fn(() => null),
    usesLocalStream: vi.fn(() => false),
  };
  const orchestrator = new Orchestrator({
    api: {} as never,
    configService,
    processManager,
    screenshotService,
    heartbeatService,
    logger: silentLogger,
  });
  return { orchestrator, processManager, screenshotService, heartbeatService, configService };
}

describe('Orchestrator', () => {
  beforeEach(() => {
    env.HTTP_RETRY_MAX_MS = 1;
    env.CONFIG_REFRESH_SECONDS = 5;
    env.HEARTBEAT_INTERVAL_SECONDS = 5;
  });

  it('starts only the cameras that were added', async () => {
    const { orchestrator, processManager, screenshotService } = setup();
    await orchestrator.applyDiff(makeDiff({ added: [makeCamera(1), makeCamera(2)] }));
    expect(processManager.start).toHaveBeenCalledTimes(2);
    expect(screenshotService.start).toHaveBeenCalledTimes(2);
  });

  it('restarts ONLY the camera whose stream key changed', async () => {
    const { orchestrator, processManager, screenshotService } = setup();
    const rotated = makeCamera(2, { streamKey: 'sk-rotated', rtmpPublishUrl: 'rtmp://…/live/sk-rotated' });
    await orchestrator.applyDiff(makeDiff({ changed: [rotated], unchanged: [makeCamera(1), makeCamera(3)] }));

    expect(processManager.start).toHaveBeenCalledTimes(1);
    expect(processManager.start).toHaveBeenCalledWith(rotated);
    expect(processManager.start.mock.calls[0]![0].id).toBe(2);
    expect(screenshotService.start).toHaveBeenCalledTimes(1);
    expect(screenshotService.start.mock.calls[0]![0].id).toBe(2);
  });

  it('stops only the cameras that were removed', async () => {
    const { orchestrator, processManager, screenshotService } = setup();
    const removed = makeCamera(4);
    await orchestrator.applyDiff(makeDiff({ removed: [removed] }));
    expect(processManager.forget).toHaveBeenCalledTimes(1);
    expect(processManager.forget).toHaveBeenCalledWith(4, expect.any(String));
    expect(screenshotService.stop).toHaveBeenCalledWith(4);
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it('does not touch any process when the backend is unreachable', async () => {
    const { orchestrator, processManager, screenshotService, configService } = setup();
    configService.refresh.mockResolvedValue(null); // backend down
    await orchestrator.applyDiff(await configService.refresh());
    expect(processManager.start).not.toHaveBeenCalled();
    expect(processManager.forget).not.toHaveBeenCalled();
    expect(screenshotService.stop).not.toHaveBeenCalled();
  });

  it('keeps healthy processes running when a config refresh cycle fails', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, processManager, configService } = setup();
      configService.refresh.mockRejectedValue(new Error('backend down'));
      orchestrator.startLoops();
      await vi.advanceTimersByTimeAsync(5000); // one refresh cycle
      expect(configService.refresh).toHaveBeenCalledTimes(1);
      expect(processManager.start).not.toHaveBeenCalled();
      expect(processManager.stopAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bootstrap retries until the backend answers', async () => {
    const { orchestrator, processManager, configService } = setup();
    configService.refresh
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeDiff({ added: [makeCamera(1)] }));
    await orchestrator.bootstrap();
    expect(configService.refresh).toHaveBeenCalledTimes(3);
    expect(processManager.start).toHaveBeenCalledTimes(1);
  });

  it('does not poll the backend for config when using a local STREAM_URL', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, configService } = setup();
      configService.usesLocalStream.mockReturnValue(true);
      orchestrator.startLoops();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(configService.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('graceful shutdown stops all processes and loops', async () => {
    const { orchestrator, processManager, screenshotService } = setup();
    orchestrator.startLoops();
    await orchestrator.shutdown();
    expect(screenshotService.stopAll).toHaveBeenCalled();
    expect(processManager.stopAll).toHaveBeenCalled();
  });
});