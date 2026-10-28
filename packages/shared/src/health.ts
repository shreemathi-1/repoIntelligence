import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string().min(1),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
  checks: z.object({
    // 'unavailable' means we could not determine it, which is not the same as down.
    database: z.enum(['up', 'down', 'unavailable']),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
