import { z } from 'zod';

// Blank values in a copied .env should behave like unset ones.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const AUTH_KEYS = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'JWT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
] as const;

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_URL: z.url(),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  WORKER_URL: optional(z.url()),
  WORKER_SHARED_SECRET: optional(z.string().min(16)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GITHUB_CLIENT_ID: optional(z.string().min(1)),
  GITHUB_CLIENT_SECRET: optional(z.string().min(1)),
  GITHUB_CALLBACK_URL: optional(z.url()),
  JWT_SECRET: optional(z.string().min(32)),
  // Base64 encoding of exactly 32 random bytes.
  TOKEN_ENCRYPTION_KEY: optional(
    z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be base64 for exactly 32 bytes',
    }),
  ),
  // Read-only token for anonymous discovery and the trending job. Public data only.
  GITHUB_TOKEN: optional(z.string().min(1)),
  TRENDING_JOB_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

// Auth is all-or-nothing: a half-configured login is worse than none.
const envSchema = envObject.superRefine((env, ctx) => {
  const missing = AUTH_KEYS.filter((key) => env[key] === undefined);
  if (missing.length > 0 && missing.length < AUTH_KEYS.length) {
    for (const key of missing) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'required when any auth variable is set',
      });
    }
  }
});

export type Config = z.infer<typeof envObject>;

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  jwtSecret: string;
  tokenKey: Buffer;
}

/** Returns the auth settings, or undefined when login is not configured. */
export function authConfigOf(config: Config): AuthConfig | undefined {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL, JWT_SECRET } = config;
  if (
    !GITHUB_CLIENT_ID ||
    !GITHUB_CLIENT_SECRET ||
    !GITHUB_CALLBACK_URL ||
    !JWT_SECRET ||
    !config.TOKEN_ENCRYPTION_KEY
  ) {
    return undefined;
  }
  return {
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    callbackUrl: GITHUB_CALLBACK_URL,
    jwtSecret: JWT_SECRET,
    tokenKey: Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'base64'),
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validates the environment. Only variable names and rules are reported, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return result.data;
}
