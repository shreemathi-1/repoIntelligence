import { z } from 'zod';

export const preferencesSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  defaultLanguage: z.string().min(1).max(50).optional(),
  // Opting in means the next login asks GitHub for the broader `repo` scope.
  privateRepoAccess: z.boolean(),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const preferencesUpdateSchema = preferencesSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one preference');

export type PreferencesUpdate = z.infer<typeof preferencesUpdateSchema>;

export const publicUserSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1),
  avatarUrl: z.string().optional(),
  preferences: preferencesSchema,
  // True when the stored token was granted the private repository scope.
  privateRepoScope: z.boolean(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const meResponseSchema = z.object({ user: publicUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;
