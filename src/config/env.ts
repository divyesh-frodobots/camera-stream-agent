import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve .env from the project root independent of the current working
// directory (important when running as a Windows Service under LocalSystem).
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

/** Treats an empty or whitespace-only value as "not set" so a blank line in
 * .env falls back to the default instead of failing validation. */
function optional(schema: z.ZodTypeAny): z.ZodTypeAny {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);
}

/** z.coerce.boolean() maps the string "false" to true, so parse explicitly. */
function boolean(defaultValue: boolean): z.ZodTypeAny {
  return optional(
    z.preprocess((v) => {
      if (typeof v !== 'string') return v;
      const text = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(text)) return true;
      if (['0', 'false', 'no', 'off'].includes(text)) return false;
      return v;
    }, z.boolean().default(defaultValue)),
  );
}

export const DEFAULT_AGORA_CHANNEL = 'offroad_cam_1';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // Validated at startup (index.ts) rather than here so unit tests can run
  // without a .env file.
  BACKEND_URL: z.string().url().default('http://localhost:3000'),
  AGENT_ID: z.string().optional().describe('Fallback agent id; the backend config response is authoritative'),
  AGENT_API_KEY: z.string().default(''),

  // When set, the agent streams this camera URL locally and does not call
  // GET /api/camera-agent/config. RTMP_PUBLISH_URL is required in that mode.
  STREAM_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  RTMP_PUBLISH_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),

  // Shared Agora channel for local publishers. Stream keys must match this
  // channel. Operators do not set App ID or token in this package.
  AGORA_CHANNEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).default(DEFAULT_AGORA_CHANNEL),
  ),
  // File-mode control UI binds 127.0.0.1 on this port. Backend mode skips it.
  AGORA_VIEWER_PORT: z.coerce.number().int().min(1).max(65535).default(3456),

  // Encode target for file mode and STREAM_URL local stream (ignored when the
  // backend config is used). Match these to what the camera actually delivers:
  // forcing a higher resolution than the source only wastes CPU and uplink.
  LOCAL_VIDEO_WIDTH: optional(z.coerce.number().int().min(16).max(7680).default(1920)),
  LOCAL_VIDEO_HEIGHT: optional(z.coerce.number().int().min(16).max(4320).default(1080)),
  LOCAL_VIDEO_FPS: optional(z.coerce.number().int().min(1).max(60).default(25)),
  LOCAL_VIDEO_BITRATE_KBPS: optional(z.coerce.number().int().min(100).max(50_000).default(3000)),
  // When false FFmpeg remuxes with -c copy instead of re-encoding, which needs
  // the source to already be H.264 (and AAC if audio stays enabled).
  LOCAL_VIDEO_TRANSCODE: boolean(true),
  LOCAL_AUDIO_ENABLED: boolean(true),

  FFMPEG_PATH: z.string().default('ffmpeg'),

  // polling / intervals
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(15),
  CONFIG_REFRESH_SECONDS: z.coerce.number().int().min(5).default(30),
  SCREENSHOT_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(1),
  SCREENSHOT_DIR: z.string().default('./data/screenshots'),

  // restart policy
  RESTART_BASE_DELAY_SECONDS: z.coerce.number().min(0.5).default(5),
  RESTART_MAX_DELAY_SECONDS: z.coerce.number().min(1).default(60),
  // reset the restart counter after the stream stays healthy this long
  HEALTHY_RESET_SECONDS: z.coerce.number().int().min(10).default(300),
  // if no frame progress arrives within this window, the stream is unhealthy
  FFMPEG_HEALTH_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(45),
  // how long to wait for a graceful FFmpeg shutdown before SIGKILL
  FFMPEG_KILL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  FFMPEG_START_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),

  // http
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  HTTP_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1000),
  HTTP_RETRY_MAX_MS: z.coerce.number().int().min(1000).default(30000),

  // ffmpeg input tuning
  RTSP_TIMEOUT_MICROS: z.coerce.number().int().min(0).default(15_000_000),
  FFMPEG_PROBESIZE: z.string().default('1000000'),
  FFMPEG_ANALYZEDURATION: z.string().default('1000000'),
});

export type AgentEnv = z.infer<typeof envSchema>;

function loadEnv(): AgentEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

export const env: AgentEnv = loadEnv();