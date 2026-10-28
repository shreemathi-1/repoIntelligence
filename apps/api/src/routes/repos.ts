import { Router } from 'express';
import { ownerNameParams } from '@repointelligence/shared';
import { authConfigOf, type Config } from '../config.js';
import { recordHistory } from '../discovery/history.js';
import type { GithubService } from '../github/service.js';
import { loadViewer } from '../github/viewer.js';

/**
 * Mounted behind optionalAuth. A signed-in visitor's own token is used, so private repository
 * access follows GitHub's rules; anonymous visitors only see public data.
 */
export function createReposRouter(config: Config, github: GithubService): Router {
  const router = Router();
  const auth = authConfigOf(config);

  router.get('/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const viewer = await loadViewer(res.locals.userId, auth);
    const result = await github.getRepo(owner, name, viewer);
    if (viewer) {
      await recordHistory(viewer.userId, { kind: 'viewed', fullName: result.repo.fullName });
    }
    res.json(result);
  });

  return router;
}
