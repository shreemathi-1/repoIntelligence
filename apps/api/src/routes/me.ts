import { Router } from 'express';
import {
  preferencesUpdateSchema,
  type MeResponse,
  type PublicUser,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';
import { User } from '../models/user.js';

function toPublic(user: InstanceType<typeof User>): PublicUser {
  const prefs = user.preferences;
  return {
    id: user.id,
    login: user.login,
    ...(user.avatarUrl && { avatarUrl: user.avatarUrl }),
    preferences: {
      theme: prefs.theme,
      ...(prefs.defaultLanguage && { defaultLanguage: prefs.defaultLanguage }),
      privateRepoAccess: prefs.privateRepoAccess,
    },
    privateRepoScope: user.tokenScopes.includes('repo'),
  };
}

/** Mounted behind requireAuth, so `res.locals.userId` is set. */
export function createMeRouter(): Router {
  const router = Router();

  const load = async (id: unknown): Promise<InstanceType<typeof User>> => {
    const user = await User.findById(id);
    if (!user) throw AppError.unauthorized();
    return user;
  };

  router.get('/', async (_req, res) => {
    const body: MeResponse = { user: toPublic(await load(res.locals.userId)) };
    res.json(body);
  });

  router.get('/preferences', async (_req, res) => {
    res.json(toPublic(await load(res.locals.userId)).preferences);
  });

  router.patch('/preferences', async (req, res) => {
    const update = preferencesUpdateSchema.parse(req.body);
    const set = Object.fromEntries(
      Object.entries(update).map(([key, value]) => [`preferences.${key}`, value]),
    );
    const user = await User.findByIdAndUpdate(
      res.locals.userId,
      { $set: set },
      { returnDocument: 'after' },
    );
    if (!user) throw AppError.unauthorized();
    res.json(toPublic(user).preferences);
  });

  return router;
}
