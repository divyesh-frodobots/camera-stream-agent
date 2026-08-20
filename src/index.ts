import fs from 'node:fs';
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
import { startControlServer } from './control/controlServer';
import { selectAgentMode, shouldStartControlServer } from './localMode/agentMode';
import { CamerasStore } from './localMode/camerasStore';
import { LocalPublisher } from './localMode/localPublisher';

const VERSION = '1.0.0';

const AGENT_ROOT = path.join(__dirname, '..');

const localVideo = {
  width: env.LOCAL_VIDEO_WIDTH,
  height: env.LOCAL_VIDEO_HEIGHT,
  fps: env.LOCAL_VIDEO_FPS,
  bitrateKbps: env.LOCAL_VIDEO_BITRATE_KBPS,
  transcodeEnabled: env.LOCAL_VIDEO_TRANSCODE,
  audioEnabled: env.LOCAL_AUDIO_ENABLED,
};

async function main(): Promise<void> {
  logger.info({ version: VERSION, node: process.version }, 'camera stream agent starting');

  const camerasPath = path.join(AGENT_ROOT, 'data', 'cameras.json');
  const htmlPath = path.join(AGENT_ROOT, 'ui', 'control.html');

  const platform = createPlatformService(process.platform, { rootDir: AGENT_ROOT });
  const killProcess = (pid: number) => void platform.terminateProcessTree(pid);

  const processManager = new CameraProcessManager({
    ffmpegPath: platform.ffmpegBinary,
    killProcess,
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

  const store = new CamerasStore({ filePath: camerasPath });
  const publisher = new LocalPublisher({
    store,
    processManager,
    logger,
    video: localVideo,
  });
  const loaded = await publisher.load();
  if (loaded.invalidMessage) {
    logger.warn(
      { invalidMessage: loaded.invalidMessage },
      'cameras.json is invalid; control UI is available and no publishers will start',
    );
  }

  const mode = selectAgentMode({
    camerasFileExists: fs.existsSync(camerasPath),
    hasConfiguredCamera: publisher.snapshot().cameras.some((camera) => camera.configured),
    streamUrl: env.STREAM_URL,
    agentApiKey: env.AGENT_API_KEY,
  });

  let closeControl: (() => Promise<void>) | undefined;
  let orchestrator: Orchestrator | undefined;

  const shutdown = createShutdown({
    processManager,
    getOrchestrator: () => orchestrator,
    getCloseControl: () => closeControl,
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (shouldStartControlServer(mode)) {
    closeControl = await listenControlServer(publisher, htmlPath);
  }

  if (mode === 'file') {
    await runFileMode(publisher);
    return;
  }

  if (mode === 'env-single' && !env.RTMP_PUBLISH_URL) {
    throw new Error('RTMP_PUBLISH_URL is required when STREAM_URL is set');
  }

  orchestrator = await runBackendOrEnvSingle({
    processManager,
    ffmpegPath: platform.ffmpegBinary,
    killProcess,
  });
  logger.info({ mode }, 'agent is running');
}

async function runFileMode(publisher: LocalPublisher): Promise<void> {
  logger.info({ mode: 'file' }, 'running in local file mode');
  try {
    await publisher.startEnabledOnBoot();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      'failed to start enabled cameras on boot; control UI remains available',
    );
  }
  logger.info('agent is running');
}

async function listenControlServer(
  publisher: LocalPublisher,
  htmlPath: string,
): Promise<() => Promise<void>> {
  try {
    const started = await startControlServer({
      publisher,
      port: env.AGORA_VIEWER_PORT,
      htmlPath,
      logger,
    });
    return started.close;
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code: unknown }).code
        : undefined;
    logger.fatal(
      {
        err: err instanceof Error ? err.message : err,
        code,
        host: '127.0.0.1',
        port: env.AGORA_VIEWER_PORT,
      },
      'fatal: control server failed to listen',
    );
    process.exit(1);
    throw err;
  }
}

async function runBackendOrEnvSingle(opts: {
  processManager: CameraProcessManager;
  ffmpegPath: string;
  killProcess: (pid: number) => void;
}): Promise<Orchestrator> {
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
    localVideo,
  });

  const screenshotService = new ScreenshotService({
    api,
    logger,
    ffmpegPath: opts.ffmpegPath,
    killProcess: opts.killProcess,
  });
  await screenshotService.ensureDir();
  if (env.AGENT_API_KEY) {
    screenshotService.startUploadLoop();
  }

  const heartbeatService = new HeartbeatService({
    api,
    processManager: opts.processManager,
    logger,
    version: VERSION,
    getAgentId: () => configService.getAgentId(),
  });

  const orchestrator = new Orchestrator({
    api,
    configService,
    processManager: opts.processManager,
    screenshotService,
    heartbeatService,
    logger,
  });

  await orchestrator.bootstrap();
  orchestrator.startLoops();
  return orchestrator;
}

function createShutdown(opts: {
  processManager: CameraProcessManager;
  getOrchestrator: () => Orchestrator | undefined;
  getCloseControl: () => (() => Promise<void>) | undefined;
}): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');
    const orchestrator = opts.getOrchestrator();
    try {
      if (orchestrator) {
        await orchestrator.shutdown();
      } else {
        await opts.processManager.stopAll();
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        'shutdown failed to stop FFmpeg children',
      );
    }
    try {
      await opts.getCloseControl()?.();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        'failed to close control server',
      );
    }
    process.exit(0);
  };
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'agent failed to start');
  process.exit(1);
});
