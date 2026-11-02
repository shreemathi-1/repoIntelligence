import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GithubService, Viewer } from '../github/service.js';

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({ tree: z.object({ sha: z.string() }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), sha: z.string(), type: z.string() })),
});
const IMMUTABLE_MS = 24 * 3_600_000;

export async function resolveCommitSha(
  github: GithubService,
  owner: string,
  name: string,
  ref: string,
  viewer?: Viewer,
): Promise<string> {
  const { data } = await github.getJson(
    {
      route: 'GET /repos/{owner}/{repo}/commits/{ref}',
      params: { owner, repo: name, ref },
      schema: commitSchema,
      freshMs: /^[0-9a-f]{40}$/i.test(ref) ? IMMUTABLE_MS : 60_000,
    },
    viewer,
  );
  return data.sha;
}

/** A fingerprint of every file in the commit, or null when GitHub cut the listing short. */
export async function treeDigestOf(
  github: GithubService,
  owner: string,
  name: string,
  sha: string,
): Promise<string | null> {
  const { data: commit } = await github.getJson({
    route: 'GET /repos/{owner}/{repo}/commits/{ref}',
    params: { owner, repo: name, ref: sha },
    schema: commitSchema,
    freshMs: IMMUTABLE_MS,
  });
  const { data: tree } = await github.getJson({
    route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    params: { owner, repo: name, tree_sha: commit.commit.tree.sha, recursive: '1' },
    schema: treeSchema,
    freshMs: IMMUTABLE_MS,
  });
  if (tree.truncated) return null;
  const hash = createHash('sha256');
  for (const entry of tree.tree
    .filter((e) => e.type === 'blob')
    .sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.sha}\n`);
  }
  return hash.digest('hex');
}
