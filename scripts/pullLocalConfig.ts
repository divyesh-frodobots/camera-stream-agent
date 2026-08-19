/**
 * One-shot snapshot: pull STREAM_URL / RTMP_PUBLISH_URL and a 7-day Agora
 * viewer session from the backend into .env. After this, the agent can stream
 * without calling the backend, and `npm run viewer` uses the cached token.
 *
 *   npm run pull-local-config
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env';
import { AgentApi } from '../src/api/agentApi';
import { upsertEnvVars } from '../src/localMode/envFile';
import { logger } from '../src/utils/logger';
import { maskUrl } from '../src/utils/mask';

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

async function readOrCreateEnv(): Promise<string> {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    try {
      return await fs.readFile(EXAMPLE_PATH, 'utf8');
    } catch {
      return '';
    }
  }
}

async function main(): Promise<void> {
  if (!env.AGENT_API_KEY) {
    throw new Error('AGENT_API_KEY is required to pull config from the backend');
  }

  const api = new AgentApi({
    baseUrl: env.BACKEND_URL,
    apiKey: env.AGENT_API_KEY,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
    retryBaseMs: env.HTTP_RETRY_BASE_MS,
    retryMaxMs: env.HTTP_RETRY_MAX_MS,
    logger,
  });

  const config = await api.fetchConfig();
  const camera = config.cameras[0];
  if (!camera) {
    throw new Error('Backend returned no cameras with an active stream key for this agent');
  }

  const session = await api.fetchViewerSession();

  const next = upsertEnvVars(await readOrCreateEnv(), {
    STREAM_URL: camera.rtspUrl,
    RTMP_PUBLISH_URL: camera.rtmpPublishUrl,
    AGORA_APP_ID: session.appId,
    AGORA_CHANNEL: session.channel,
    AGORA_RTC_TOKEN: session.token,
    AGORA_RTC_TOKEN_EXPIRES_AT: session.expiresAt,
  });
  await fs.writeFile(ENV_PATH, next, 'utf8');

  logger.info(
    {
      cameraId: camera.id,
      cameraName: camera.name,
      channel: session.channel,
      rtsp: maskUrl(camera.rtspUrl),
      rtmp: maskUrl(camera.rtmpPublishUrl),
      streamKeyExpiresAt: camera.streamKeyExpiresAt,
      tokenExpiresAt: session.expiresAt,
      envPath: ENV_PATH,
    },
    'wrote 7-day local stream snapshot to .env',
  );
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'pull-local-config failed');
  process.exit(1);
});
