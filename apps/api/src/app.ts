import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { healthResponseSchema, type HealthResponse } from '@repointelligence/shared';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { genRequestId } from './middleware/request-id.js';
import cookieParser from 'cookie-parser';
import { createApiRouter, type AppDeps } from './routes/index.js';

const SERVICE_NAME = 'repointelligence-api';
const VERSION = '0.1.0';

function databaseState(): HealthResponse['checks']['database'] {
  switch (mongoose.connection.readyState) {
    case mongoose.ConnectionStates.connected:
      return 'up';
    case mongoose.ConnectionStates.disconnected:
      return 'down';
    default:
      return 'unavailable';
  }
}

export function createApp(config: Config, logger: Logger, deps: AppDeps = {}): Express {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = genRequestId(req.headers['x-request-id']);
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_URL, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    const database = databaseState();
    const body = healthResponseSchema.parse({
      status: database === 'up' ? 'ok' : 'degraded',
      service: SERVICE_NAME,
      version: VERSION,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { database },
    });
    res.json(body);
  });

  // Health is exempt so probes and uptime monitors are never throttled.
  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 100,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );
  app.use('/api/v1', createApiRouter(config, deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
