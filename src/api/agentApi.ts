import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AgentConfigResponse, HeartbeatPayload } from '../types/agentConfig';
import { env } from '../config/env';
import type { Logger } from '../utils/loggerTypes';

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  logger: Logger;
  httpImpl?: AxiosInstance;
  maxRetries?: number;
}

/**
 * Minimal HTTP client for the backend's agent endpoints. Uses an API key that
 * is never stored on the backend in plaintext and never logged here.
 */
export class AgentApi {
  private readonly http: AxiosInstance;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxRetries: number;

  constructor(private readonly deps: ApiClientOptions) {
    this.http =
      deps.httpImpl ??
      axios.create({
        baseURL: deps.baseUrl,
        timeout: deps.timeoutMs,
        headers: { 'X-API-Key': deps.apiKey, Accept: 'application/json' },
      });
    this.retryBaseMs = deps.retryBaseMs;
    this.retryMaxMs = deps.retryMaxMs;
    this.maxRetries = deps.maxRetries ?? 5;
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof AxiosError) {
      // network errors and 5xx are retryable; 4xx are not (config/auth errors
      // would only loop forever)
      return err.response === undefined || err.response.status >= 500;
    }
    return true;
  }

  private async withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        attempt += 1;
        if (!this.isRetryable(err) || attempt > this.maxRetries) {
          if (err instanceof AxiosError && err.response) {
            this.deps.logger.error(
              { what, status: err.response.status, message: err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message },
              'backend request failed (non-retryable)',
            );
          }
          throw err;
        }
        const delay = Math.min(this.retryBaseMs * Math.pow(2, attempt - 1), this.retryMaxMs);
        this.deps.logger.warn({ what, attempt, delayMs: delay }, 'backend request failed; retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async fetchConfig(): Promise<AgentConfigResponse> {
    return this.withRetry(async () => {
      const { data } = await this.http.get<AgentConfigResponse>('/api/camera-agent/config');
      return data;
    }, 'fetchConfig');
  }

  async sendHeartbeat(payload: HeartbeatPayload): Promise<void> {
    await this.withRetry(async () => {
      await this.http.post('/api/camera-agent/heartbeat', payload);
    }, 'heartbeat');
  }

  async uploadScreenshot(cameraId: number, jpeg: Buffer): Promise<void> {
    await this.withRetry(
      async () => {
        await this.http.post(`/api/camera-agent/screenshot?cameraId=${cameraId}`, jpeg, {
          headers: { 'Content-Type': 'image/jpeg' },
          maxBodyLength: 3 * 1024 * 1024,
        });
      },
      `screenshot:${cameraId}`,
    );
  }
}