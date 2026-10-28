import { Router, type Response } from 'express';
import mongoose from 'mongoose';
import {
  collectionInputSchema,
  ownerNameParams,
  saveRepoSchema,
  type CollectionView,
  type HistoryItem,
  type SavedItem,
  type WatchChange,
} from '@repointelligence/shared';
import { authConfigOf, type Config } from '../config.js';
import type { DiscoveryService } from '../discovery/service.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { Collection } from '../models/collection.js';
import { Repository } from '../models/repository.js';
import { SavedRepository } from '../models/saved-repository.js';
import { SearchHistory } from '../models/search-history.js';
import { Watch } from '../models/watch.js';

const MAX_WATCHED = 25;

/** Everything here belongs to the signed-in user. Mounted behind requireAuth. */
export function createLibraryRouter(config: Config, discovery: DiscoveryService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const uid = (res: Response): string => String(res.locals.userId);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);

  /** Looks the repo up on GitHub, so only real repositories can be saved, then stores a copy. */
  async function ensureRepository(owner: string, name: string, res: Response) {
    const card = await discovery.repoCard(owner, name, await viewerOf(res));
    return Repository.findOneAndUpdate(
      { fullName: card.fullName.toLowerCase() },
      {
        $set: {
          owner: card.fullName.split('/')[0],
          name: card.fullName.split('/')[1],
          description: card.description ?? undefined,
          primaryLanguage: card.language ?? undefined,
          stars: card.stars,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
  }

  async function findRepository(owner: string, name: string) {
    const repo = await Repository.findOne({ fullName: `${owner}/${name}`.toLowerCase() });
    if (!repo) throw AppError.notFound('Repository is not in your library');
    return repo;
  }

  // ---- saved repositories ----

  router.get('/saved', async (_req, res) => {
    const userId = uid(res);
    const [saved, collections] = await Promise.all([
      SavedRepository.find({ user: userId }).sort({ createdAt: -1 }).populate('repository'),
      Collection.find({ user: userId }),
    ]);
    const items: SavedItem[] = saved.flatMap((entry) => {
      const repo = entry.repository as unknown as InstanceType<typeof Repository> | null;
      if (!repo) return [];
      return [
        {
          fullName: repo.fullName,
          description: repo.description ?? null,
          language: repo.primaryLanguage ?? null,
          stars: repo.stars ?? null,
          note: entry.note ?? null,
          savedAt: entry.createdAt.toISOString(),
          collections: collections
            .filter((c) => c.repositories.some((id) => id.equals(repo._id)))
            .map((c) => c.name),
        },
      ];
    });
    res.json({ items });
  });

  router.post('/saved', async (req, res) => {
    const { fullName, note } = saveRepoSchema.parse(req.body);
    const [owner = '', name = ''] = fullName.split('/');
    const repo = await ensureRepository(owner, name, res);
    await SavedRepository.updateOne(
      { user: uid(res), repository: repo._id },
      { $set: { note } },
      { upsert: true },
    );
    res.status(201).json({ fullName: repo.fullName });
  });

  router.delete('/saved/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const repo = await findRepository(owner, name);
    await SavedRepository.deleteOne({ user: uid(res), repository: repo._id });
    await Collection.updateMany({ user: uid(res) }, { $pull: { repositories: repo._id } });
    res.status(204).end();
  });

  // ---- collections ----

  const toView = async (c: InstanceType<typeof Collection>): Promise<CollectionView> => {
    const repos = await Repository.find({ _id: { $in: c.repositories } });
    return {
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      repositories: repos.map((r) => r.fullName),
    };
  };

  const loadCollection = async (id: string, res: Response) => {
    const collection = mongoose.isValidObjectId(id)
      ? await Collection.findOne({ _id: id, user: uid(res) })
      : null;
    if (!collection) throw AppError.notFound('Collection not found');
    return collection;
  };

  router.get('/collections', async (_req, res) => {
    const collections = await Collection.find({ user: uid(res) }).sort({ name: 1 });
    res.json({ items: await Promise.all(collections.map(toView)) });
  });

  router.post('/collections', async (req, res) => {
    const input = collectionInputSchema.parse(req.body);
    try {
      const created = await Collection.create({ user: uid(res), ...input });
      res.status(201).json(await toView(created));
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 11000) {
        throw AppError.conflict('You already have a collection with this name');
      }
      throw err;
    }
  });

  router.delete('/collections/:id', async (req, res) => {
    const collection = await loadCollection(req.params.id, res);
    await collection.deleteOne();
    res.status(204).end();
  });

  router.put('/collections/:id/repos/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const collection = await loadCollection(req.params.id, res);
    const repo = await findRepository(owner, name);
    if (!(await SavedRepository.exists({ user: uid(res), repository: repo._id }))) {
      throw AppError.badRequest('Save the repository before adding it to a collection');
    }
    await Collection.updateOne({ _id: collection._id }, { $addToSet: { repositories: repo._id } });
    res.json(await toView(await loadCollection(collection.id, res)));
  });

  router.delete('/collections/:id/repos/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const collection = await loadCollection(req.params.id, res);
    const repo = await findRepository(owner, name);
    await Collection.updateOne({ _id: collection._id }, { $pull: { repositories: repo._id } });
    res.status(204).end();
  });

  // ---- watchlist ----

  router.get('/watchlist', async (_req, res) => {
    const watches = await Watch.find({ user: uid(res) })
      .sort({ createdAt: -1 })
      .populate('repository');
    res.json({
      items: watches.flatMap((w) => {
        const repo = w.repository as unknown as InstanceType<typeof Repository> | null;
        return repo ? [{ fullName: repo.fullName, addedAt: w.createdAt.toISOString() }] : [];
      }),
    });
  });

  router.put('/watchlist/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    if ((await Watch.countDocuments({ user: uid(res) })) >= MAX_WATCHED) {
      throw AppError.badRequest(`You can watch up to ${MAX_WATCHED} repositories`);
    }
    const repo = await ensureRepository(owner, name, res);
    await Watch.updateOne({ user: uid(res), repository: repo._id }, {}, { upsert: true });
    res.status(201).json({ fullName: repo.fullName });
  });

  router.delete('/watchlist/:owner/:name', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const repo = await findRepository(owner, name);
    await Watch.deleteOne({ user: uid(res), repository: repo._id });
    res.status(204).end();
  });

  router.get('/watchlist/changes', async (_req, res) => {
    const viewer = await viewerOf(res);
    const watches = await Watch.find({ user: uid(res) }).populate('repository');
    const items = await Promise.all(
      watches.map(async (watch): Promise<WatchChange> => {
        const repo = watch.repository as unknown as InstanceType<typeof Repository>;
        const [owner = '', name = ''] = repo.fullName.split('/');
        try {
          const now = await discovery.observe(owner, name, viewer);
          const seen = watch.lastSeen;
          // Without a previous look there is nothing to compare, which is not "no change".
          const compared = Boolean(seen?.checkedAt);
          return {
            fullName: repo.fullName,
            status: 'ok',
            latestRelease: now.release,
            latestCommitSha: now.commitSha,
            latestCommitAt: now.commitAt,
            openIssues: now.openIssues,
            newRelease:
              compared && now.release !== null ? now.release !== (seen?.releaseTag ?? null) : null,
            newCommits:
              compared && now.commitSha !== null
                ? now.commitSha !== (seen?.commitSha ?? null)
                : null,
            openIssuesDelta:
              compared && seen?.openIssues !== undefined && seen.openIssues !== null
                ? now.openIssues - seen.openIssues
                : null,
          };
        } catch (err) {
          if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
          return {
            fullName: repo.fullName,
            status: 'unavailable',
            latestRelease: null,
            latestCommitSha: null,
            latestCommitAt: null,
            openIssues: null,
            newRelease: null,
            newCommits: null,
            openIssuesDelta: null,
          };
        }
      }),
    );
    res.json({ items });
  });

  router.post('/watchlist/:owner/:name/seen', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const repo = await findRepository(owner, name);
    const now = await discovery.observe(owner, name, await viewerOf(res));
    const result = await Watch.updateOne(
      { user: uid(res), repository: repo._id },
      {
        $set: {
          lastSeen: {
            checkedAt: new Date(),
            releaseTag: now.release ?? undefined,
            commitSha: now.commitSha ?? undefined,
            openIssues: now.openIssues,
          },
        },
      },
    );
    if (result.matchedCount === 0) throw AppError.notFound('You are not watching this repository');
    res.status(204).end();
  });

  // ---- history ----

  router.get('/history', async (_req, res) => {
    const rows = await SearchHistory.find({ user: uid(res) })
      .sort({ at: -1 })
      .limit(50);
    const items: HistoryItem[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      query: row.query || null,
      fullName: row.fullName || null,
      at: row.at.toISOString(),
    }));
    res.json({ items });
  });

  router.delete('/history', async (_req, res) => {
    await SearchHistory.deleteMany({ user: uid(res) });
    res.status(204).end();
  });

  return router;
}
