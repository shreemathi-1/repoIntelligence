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
    const user = await User.create({ githubId: 9, login: 'runner' });
    const run = await AnalysisRun.create({ fullName: 'A/B', requestedBy: user._id });
    expect(run.status).toBe('queued');
    expect(run.fullName).toBe('a/b');
    expect(run.progress.step).toBe('queued');
    await expect(
      AnalysisRun.create({ fullName: 'a/b', requestedBy: user._id, status: 'weird' as 'queued' }),
    ).rejects.toThrow(/validation/i);
  });

  it('stores chat messages with citations', async () => {
    const user = await User.create({ githubId: 2, login: 'u2' });
    const session = await ChatSession.create({
      user: user._id,
      fullName: 'c/d',
      sha: 'a'.repeat(40),
      messages: [
        {
          role: 'assistant',
          content: 'See the entry point',
          citations: [{ path: 'src/a.ts', startLine: 1, endLine: 4 }],
          confidence: 'verified',
        },
      ],
    });
    expect(session.messages[0]?.citations[0]?.path).toBe('src/a.ts');
    expect(session.messages[0]?.confidence).toBe('verified');
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
