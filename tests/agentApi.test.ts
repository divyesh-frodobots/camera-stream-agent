import { describe, it, expect, afterEach, vi } from 'vitest';
import { AxiosError } from 'axios';
import { AgentApi } from '../src/api/agentApi';
import { silentLogger } from './helpers/fakes';

function axiosError(status: number | undefined): AxiosError {
  return new AxiosError(
    status ? `HTTP ${status}` : 'network failure',
    status ? 'ERR_BAD_RESPONSE' : 'ECONNREFUSED',
    undefined,
    undefined,
    status
      ? { status, data: {}, headers: {}, statusText: 'Error', config: undefined as never }
      : undefined,
  );
}

function makeApi(overrides: Partial<{ maxRetries: number }> = {}) {
  const calls: string[] = [];
  const record = (method: string) => async () => {
    calls.push(method);
  };
  const http = {
    get: vi.fn(),
    post: vi.fn(),
  };
  const api = new AgentApi({
    baseUrl: 'http://backend:3000',
    apiKey: 'ag-test',
    timeoutMs: 1000,
    retryBaseMs: 100,
    retryMaxMs: 10000,
    logger: silentLogger,
    httpImpl: http as never,
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  });
  return { api, http, calls, record };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentApi retry behaviour', () => {
  it('retries network errors with exponential backoff and succeeds', async () => {
    vi.useFakeTimers();
    const { api, http, calls, record } = makeApi();
    http.get
      .mockImplementationOnce(async () => {
        calls.push('get');
        throw axiosError(undefined);
      })
      .mockImplementationOnce(async () => {
        calls.push('get');
        throw axiosError(undefined);
      })
      .mockImplementationOnce(async () => {
        calls.push('get');
        return { data: { cameras: [], configVersion: 1 } };
      });

    const promise = api.fetchConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); // base backoff
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200); // doubled backoff
    expect(calls).toHaveLength(3);
    await expect(promise).resolves.toEqual({ cameras: [], configVersion: 1 });
  });

  it('retries 5xx responses', async () => {
    vi.useFakeTimers();
    const { api, http, calls } = makeApi();
    http.get
      .mockImplementationOnce(async () => {
        calls.push('get');
        throw axiosError(503);
      })
      .mockImplementationOnce(async () => {
        calls.push('get');
        throw axiosError(500);
      })
      .mockImplementationOnce(async () => {
        calls.push('get');
        return { data: { cameras: [] } };
      });

    const promise = api.fetchConfig();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual({ cameras: [] });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx responses (config/auth errors)', async () => {
    vi.useFakeTimers();
    const { api, http, calls } = makeApi();
    http.get.mockImplementationOnce(async () => {
      calls.push('get');
      throw axiosError(401);
    });
    await expect(api.fetchConfig()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries and rethrows', async () => {
    vi.useFakeTimers();
    const { api, http, calls } = makeApi({ maxRetries: 2 });
    http.get.mockImplementation(async () => {
      calls.push('get');
      throw axiosError(undefined);
    });
    const promise = api.fetchConfig();
    void promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await expect(promise).rejects.toThrow();
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('fetches a viewer session from the agent endpoint', async () => {
    const { api, http } = makeApi();
    const payload = {
      appId: 'app',
      channel: 'offroad_cam_1',
      uid: 0,
      role: 'subscriber' as const,
      token: '007x',
      expiresAt: new Date().toISOString(),
    };
    http.get.mockResolvedValueOnce({ data: payload });
    await expect(api.fetchViewerSession()).resolves.toEqual(payload);
    expect(http.get).toHaveBeenCalledWith('/api/camera-agent/viewer-session');
  });

  it('sends heartbeats and screenshots through the same retry path', async () => {
    vi.useFakeTimers();
    const { api, http, calls } = makeApi();
    http.post
      .mockImplementationOnce(async () => {
        calls.push('post');
        throw axiosError(undefined);
      })
      .mockImplementationOnce(async () => {
        calls.push('post');
        return { status: 200, data: {} };
      });

    const heartbeat = api.sendHeartbeat({ agentId: 'a1', version: '1', cameras: [] });
    await vi.advanceTimersByTimeAsync(100);
    await expect(heartbeat).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});