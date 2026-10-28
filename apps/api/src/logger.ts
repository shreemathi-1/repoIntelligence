import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-worker-secret"]'],
      censor: '[redacted]',
    },
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  });
}
