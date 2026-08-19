import { describe, it, expect, vi } from 'vitest';
import { HeartbeatService } from '../src/services/heartbeatService';
import { silentLogger } from './helpers/fakes';

function setup() {
  const api = { sendHeartbeat: vi.fn(async () => {}) };
  const processManager = {
    getAllStates: vi.fn(() => [
      { cameraId: 1, cameraName: 'Cam 1', status: 'STREAMING', pid: 42, uptime: 5, restartCount: 2 },
    ]),
  };
  const heartbeat = new HeartbeatService({
    api: api as never,
    processManager: processManager as never,
    logger: silentLogger,
    version: '1.0.0',
    getAgentId: () => 'agent-1',
  });
  return { heartbeat, api, processManager };
}

describe('HeartbeatService', () => {
  it('reports per-camera status including restart counts', async () => {
    const { heartbeat, api } = setup();
    await heartbeat.send();
    expect(api.sendHeartbeat).toHaveBeenCalledWith({
      agentId: 'agent-1',
      version: '1.0.0',
      cameras: [
        { cameraId: 1, status: 'STREAMING', pid: 42, uptime: 5, restartCount: 2 },
      ],
    });
  });

  it('does not throw when the backend is unreachable (streams keep running)', async () => {
    const { heartbeat, api } = setup();
    api.sendHeartbeat.mockRejectedValue(new Error('connection refused'));
    await expect(heartbeat.send()).resolves.toBeUndefined();
  });

  it('waits until the agent id is known before sending', async () => {
    const { heartbeat, api } = setup();
    const unknownId = new HeartbeatService({
      api: api as never,
      processManager: {} as never,
      logger: silentLogger,
      version: '1.0.0',
      getAgentId: () => null,
    });
    await unknownId.send();
    expect(api.sendHeartbeat).not.toHaveBeenCalled();
  });
});