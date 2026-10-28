import type { Config } from '../src/config.js';

export const testConfig: Config = {
  NODE_ENV: 'test',
  PORT: 4000,
  CLIENT_URL: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://localhost:27017/test',
  WORKER_URL: undefined,
  WORKER_SHARED_SECRET: undefined,
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  GITHUB_CALLBACK_URL: undefined,
  JWT_SECRET: undefined,
  TOKEN_ENCRYPTION_KEY: undefined,
  LOG_LEVEL: 'silent',
  GITHUB_TOKEN: undefined,
  TRENDING_JOB_ENABLED: false,
  TRUST_PROXY: false,
};

export const authTestConfig: Config = {
  ...testConfig,
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  GITHUB_CALLBACK_URL: 'http://localhost:4000/api/v1/auth/github/callback',
  JWT_SECRET: 'j'.repeat(40),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
