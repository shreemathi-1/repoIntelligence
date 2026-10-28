import { describe, expect, it } from 'vitest';
import { useMemoryDb } from '../../test/db.js';
import { AnalysisRun, ChatSession, Collection, JobRecord, Repository, User } from './index.js';

useMemoryDb();

describe('models', () => {
  it('enforces a unique githubId on User', async () => {
    await User.create({ githubId: 1, login: 'octocat' });
    await expect(User.create({ githubId: 1, login: 'dup' })).rejects.toThrow(/duplicate key/);
  });

  it('lowercases Repository.fullName and leaves unknown stars unset', async () => {
    const repo = await Repository.create({ owner: 'Acme', name: 'Tool', fullName: 'Acme/Tool' });
    expect(repo.fullName).toBe('acme/tool');
    expect(repo.stars).toBeUndefined();
  });

  it('defaults AnalysisRun to queued and rejects an unknown status', async () => {
    const repo = await Repository.create({ owner: 'a', name: 'b', fullName: 'a/b' });
    const run = await AnalysisRun.create({ repository: repo._id });
    expect(run.status).toBe('queued');
    await expect(
      AnalysisRun.create({ repository: repo._id, status: 'weird' as 'queued' }),
    ).rejects.toThrow(/validation/i);
  });

  it('stores chat messages with citations', async () => {
    const user = await User.create({ githubId: 2, login: 'u2' });
    const repo = await Repository.create({ owner: 'c', name: 'd', fullName: 'c/d' });
    const session = await ChatSession.create({
      user: user._id,
      repository: repo._id,
      messages: [
        { role: 'assistant', content: 'See the entry point', citations: [{ path: 'src/a.ts' }] },
      ],
    });
    expect(session.messages[0]?.citations[0]?.path).toBe('src/a.ts');
  });

  it('keeps Collection names unique per user', async () => {
    const user = await User.create({ githubId: 3, login: 'u3' });
    await Collection.create({ user: user._id, name: 'Favourites' });
    await expect(Collection.create({ user: user._id, name: 'Favourites' })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('defaults JobRecord to pending with zero attempts', async () => {
    const job = await JobRecord.create({ type: 'analyze' });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
  });
});
