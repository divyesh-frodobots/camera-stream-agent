import path from 'node:path';
import { env } from './config/env';
import { logger } from './utils/logger';
import { createPlatformService } from './platform';
import { AgentApi } from './api/agentApi';
import { ConfigService } from './services/configService';
import { CameraProcessManager } from './ffmpeg/CameraProcessManager';
import { ScreenshotService } from './screenshots/screenshotService';
import { HeartbeatService } from './services/heartbeatService';
import { Orchestrator } from './services/orchestrator';

const VERSION = '1.0.0';

const PROJECT_ROOT = path.join(__dirname, '..', '..');

async function main(): Promise<void> {
  if (env.STREAM_URL) {
    if (!env.RTMP_PUBLISH_URL) {
      throw new Error('RTMP_PUBLISH_URL is required when STREAM_URL is set');
    }
  } else if (!env.AGENT_API_KEY) {
    throw new Error('AGENT_API_KEY is required (create an agent on the backend and copy its one-time key)');
  }
  logger.info({ version: VERSION, node: process.version }, 'camera stream agent starting');

  const api = new AgentApi({
    baseUrl: env.BACKEND_URL,
    apiKey: env.AGENT_API_KEY,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
    retryBaseMs: env.HTTP_RETRY_BASE_MS,
    retryMaxMs: env.HTTP_RETRY_MAX_MS,
    logger,
  });

  const configService = new ConfigService({
    api,
    logger,
    fallbackAgentId: env.AGENT_ID,
    localStreamUrl: env.STREAM_URL,
    localRtmpPublishUrl: env.RTMP_PUBLISH_URL,
  });

  const platform = createPlatformService(process.platform, { rootDir: PROJECT_ROOT });
  const killProcess = (pid: number) => void platform.terminateProcessTree(pid);

  const processManager = new CameraProcessManager({
    ffmpegPath: platform.ffmpegBinary,
    killProcess,
    logger,
  });

  const screenshotService = new ScreenshotService({
    api,
    logger,
    ffmpegPath: platform.ffmpegBinary,
    killProcess,
  });
  await screenshotService.ensureDir();
  if (env.AGENT_API_KEY) {
    screenshotService.startUploadLoop();
  }

  const heartbeatService = new HeartbeatService({
    api,
    processManager,
    logger,
    version: VERSION,
    getAgentId: () => configService.getAgentId(),
  });

  const orchestrator = new Orchestrator({
    api,
    configService,
    processManager,
    screenshotService,
    heartbeatService,
    logger,
  });

  processManager.onStateChange((state) => {
    logger.info(
      {
        cameraId: state.cameraId,
        cameraName: state.cameraName,
        status: state.status,
        pid: state.pid,
        restartCount: state.restartCount,
        uptime: state.uptime,
        lastError: state.lastError?.slice(0, 200) ?? null,
        progress: state.progress,
      },
      'camera state change',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');
    await orchestrator.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await orchestrator.bootstrap();
  orchestrator.startLoops();
  logger.info('agent is running');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'agent failed to start');
  process.exit(1);
});