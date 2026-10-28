import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectionListSchema,
  historyListSchema,
  savedListSchema,
  watchChangesSchema,
  watchListSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { jsonResponse, rawRepo } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { GithubService } from '../github/service.js';

useMemoryDb();

const state = { release: 'v1.0.0', sha: 'aaa111', issues: 5 };
let clock = Date.parse('2026-03-01T00:00:00Z');

/** GitHub's answers for acme/tool, driven by `state` so tests can "publish" changes. */
function api(url: string): Response | undefined {
  if (url.includes('/repos/acme/tool/releases/latest'))
    return jsonResponse({ tag_name: state.release });
  if (url.includes('/repos/acme/tool/commits')) {
    return jsonResponse([
      { sha: state.sha, commit: { committer: { date: '2026-03-01T00:00:00Z' } } },
    ]);
  }
  if (url.endsWith('/repos/acme/tool'))
    return jsonResponse(rawRepo({ open_issues_count: state.issues }));
  if (url.includes('/search/repositories'))
    return jsonResponse({ total_count: 1, incomplete_results: false, items: [rawRepo()] });
  return undefined;
}

function signedIn(githubId = 1) {
  // The clock is injected so cached answers can be aged without waiting.
  return signInWith({
    githubId,
    api,
    makeGithub: (fetchImpl) =>
      new GithubService({ fetch: fetchImpl, now: () => clock, sleep: () => Promise.resolve() }),
  });
}

beforeEach(async () => {
  for (const name of [
    'users',
    'githubcaches',
    'repositories',
    'savedrepositories',
    'collections',
    'watches',
    'searchhistories',
  ]) {
    await mongoose.connection.collection(name).deleteMany({});
  }
  Object.assign(state, { release: 'v1.0.0', sha: 'aaa111', issues: 5 });
  clock = Date.parse('2026-03-01T00:00:00Z');
});

describe('library requires a session', () => {
  it.each(['/saved', '/collections', '/watchlist', '/history'])(
    'GET %s is 401 when signed out',
    async (path) => {
      const { app } = await signInWith({ api });
      expect((await request(app).get(`/api/v1/me${path}`)).status).toBe(401);
    },
  );
});

describe('saved repositories and collections', () => {
  it('saves a repository, lists it and removes it', async () => {
    const { agent } = await signedIn();
    expect(
      (await agent.post('/api/v1/me/saved').send({ fullName: 'acme/tool', note: 'for later' }))
        .status,
    ).toBe(201);
    const list = savedListSchema.parse((await agent.get('/api/v1/me/saved')).body);
    expect(list.items[0]).toMatchObject({ fullName: 'acme/tool', note: 'for later', stars: 42 });

    expect((await agent.delete('/api/v1/me/saved/acme/tool')).status).toBe(204);
    expect(savedListSchema.parse((await agent.get('/api/v1/me/saved')).body).items).toEqual([]);
  });

  it('refuses to save a repository that does not exist on GitHub', async () => {
    const { agent } = await signedIn();
    expect((await agent.post('/api/v1/me/saved').send({ fullName: 'acme/ghost' })).status).toBe(
      404,
    );
    expect((await agent.post('/api/v1/me/saved').send({ fullName: 'not-a-repo' })).status).toBe(
      400,
    );
  });

  it('organises saved repositories into collections', async () => {
    const { agent } = await signedIn();
    await agent.post('/api/v1/me/saved').send({ fullName: 'acme/tool' });
    const created = await agent.post('/api/v1/me/collections').send({ name: 'CLI tools' });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    expect((await agent.put(`/api/v1/me/collections/${id}/repos/acme/tool`)).status).toBe(200);
    const listed = collectionListSchema.parse((await agent.get('/api/v1/me/collections')).body);
    expect(listed.items[0]?.repositories).toEqual(['acme/tool']);
    const saved = savedListSchema.parse((await agent.get('/api/v1/me/saved')).body);
    expect(saved.items[0]?.collections).toEqual(['CLI tools']);

    // Unsaving also removes it from collections.
    await agent.delete('/api/v1/me/saved/acme/tool');
    expect(
      collectionListSchema.parse((await agent.get('/api/v1/me/collections')).body).items[0]
        ?.repositories,
    ).toEqual([]);
  });

  it('rejects duplicate names, unsaved repos and unknown collections', async () => {
    const { agent } = await signedIn();
    await agent.post('/api/v1/me/collections').send({ name: 'Dup' });
    expect((await agent.post('/api/v1/me/collections').send({ name: 'Dup' })).status).toBe(409);
    expect((await agent.post('/api/v1/me/collections').send({ name: '   ' })).status).toBe(400);

    const id = ((await agent.get('/api/v1/me/collections')).body as { items: { id: string }[] })
      .items[0]?.id;
    await agent.post('/api/v1/me/saved').send({ fullName: 'acme/tool' });
    await agent.delete('/api/v1/me/saved/acme/tool');
    // The repository record still exists, but it is no longer saved by this user.
    expect((await agent.put(`/api/v1/me/collections/${id}/repos/acme/tool`)).status).toBe(400);
    expect((await agent.delete('/api/v1/me/collections/not-an-id')).status).toBe(404);
  });

  it("keeps one user's library private from another", async () => {
    const alice = await signedIn(1);
    await alice.agent.post('/api/v1/me/saved').send({ fullName: 'acme/tool' });
    const created = await alice.agent.post('/api/v1/me/collections').send({ name: 'Mine' });
    const id = (created.body as { id: string }).id;

    const bob = await signedIn(2);
    expect(savedListSchema.parse((await bob.agent.get('/api/v1/me/saved')).body).items).toEqual([]);
    expect(
      collectionListSchema.parse((await bob.agent.get('/api/v1/me/collections')).body).items,
    ).toEqual([]);
    expect((await bob.agent.delete(`/api/v1/me/collections/${id}`)).status).toBe(404);
  });
});

describe('watchlist', () => {
  it('watches, lists and unwatches', async () => {
    const { agent } = await signedIn();
    expect((await agent.put('/api/v1/me/watchlist/acme/tool')).status).toBe(201);
    expect(
      watchListSchema.parse((await agent.get('/api/v1/me/watchlist')).body).items[0]?.fullName,
    ).toBe('acme/tool');
    expect((await agent.delete('/api/v1/me/watchlist/acme/tool')).status).toBe(204);
    expect(watchListSchema.parse((await agent.get('/api/v1/me/watchlist')).body).items).toEqual([]);
  });

  it('has nothing to compare on the first check, then reports what changed since', async () => {
    const { agent } = await signedIn();
    await agent.put('/api/v1/me/watchlist/acme/tool');

    const first = watchChangesSchema.parse((await agent.get('/api/v1/me/watchlist/changes')).body)
      .items[0];
    expect(first).toMatchObject({
      status: 'ok',
      latestRelease: 'v1.0.0',
      openIssues: 5,
      newRelease: null,
      newCommits: null,
      openIssuesDelta: null,
    });

    expect((await agent.post('/api/v1/me/watchlist/acme/tool/seen')).status).toBe(204);

    // Same data: compared, and nothing changed.
    const quiet = watchChangesSchema.parse((await agent.get('/api/v1/me/watchlist/changes')).body)
      .items[0];
    expect(quiet).toMatchObject({ newRelease: false, newCommits: false, openIssuesDelta: 0 });

    // The project publishes a release, pushes a commit and gains issues.
    Object.assign(state, { release: 'v1.1.0', sha: 'bbb222', issues: 8 });
    clock += 10 * 60_000;
    const changed = watchChangesSchema.parse((await agent.get('/api/v1/me/watchlist/changes')).body)
      .items[0];
    expect(changed).toMatchObject({
      latestRelease: 'v1.1.0',
      newRelease: true,
      newCommits: true,
      openIssuesDelta: 3,
    });
  });

  it('treats a repository without releases as unknown, not as a release', async () => {
    const noReleases = vi.fn((url: string) =>
      url.includes('releases/latest') ? jsonResponse({}, 404) : api(url),
    );
    const { agent } = await signInWith({ api: noReleases });
    await agent.put('/api/v1/me/watchlist/acme/tool');
    const item = watchChangesSchema.parse((await agent.get('/api/v1/me/watchlist/changes')).body)
      .items[0];
    expect(item?.latestRelease).toBeNull();
    expect(item?.newRelease).toBeNull();
  });

  it('limits how many repositories can be watched', async () => {
    const { agent } = await signedIn();
    const user = await mongoose.connection.collection('users').findOne({});
    const docs = Array.from({ length: 25 }, () => ({
      user: user?._id,
      repository: new mongoose.Types.ObjectId(),
    }));
    await mongoose.connection.collection('watches').insertMany(docs);
    expect((await agent.put('/api/v1/me/watchlist/acme/tool')).status).toBe(400);
  });
});

describe('history', () => {
  it('records searches and viewed repositories, newest first, without duplicates', async () => {
    const { agent } = await signedIn();
    await agent.get('/api/v1/search?q=cli');
    await agent.get('/api/v1/repos/acme/tool');
    clock += 1000;
    await agent.get('/api/v1/search?q=cli');

    const items = historyListSchema.parse((await agent.get('/api/v1/me/history')).body).items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind).sort()).toEqual(['search', 'viewed']);
    expect(items.find((i) => i.kind === 'viewed')?.fullName).toBe('acme/tool');
    expect(items.find((i) => i.kind === 'search')?.query).toBe('cli archived:false');
  });

  it('does not record anything for anonymous visitors, and can be cleared', async () => {
    const { app } = await signInWith({ api });
    await request(app).get('/api/v1/search?q=cli');
    expect(await mongoose.connection.collection('searchhistories').countDocuments()).toBe(0);

    const { agent } = await signedIn();
    await agent.get('/api/v1/search?q=cli');
    expect((await agent.delete('/api/v1/me/history')).status).toBe(204);
    expect(historyListSchema.parse((await agent.get('/api/v1/me/history')).body).items).toEqual([]);
  });
});
