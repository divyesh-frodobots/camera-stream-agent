import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: 'camera-stream-agent' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      '*.password',
      '*.apiKey',
      '*.streamKey',
      '*.rtspUrl',
      '*.rtmpPublishUrl',
      '*.authorization',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});