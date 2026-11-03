import { z } from 'zod';
import { AppError } from '../errors.js';

const API = 'https://api.github.com';

const repoSchema = z.object({
  default_branch: z.string(),
  private: z.boolean(),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});
const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const commitSchema = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) });
const shaSchema = z.object({ sha: z.string() });
const pullSchema = z.object({
  number: z.number().int(),
  html_url: z.url(),
  draft: z.boolean().optional(),
});

export interface ProposedFile {
  path: string;
  content: string;
}

export interface ProposeInput {
  owner: string;
  name: string;
  token: string;
  files: ProposedFile[];
  /** Branch name to try first; a suffix is added when it is taken. */
  branch: string;
  title: string;
  body: string;
}

export interface Proposed {
  number: number;
  url: string;
  branch: string;
  base: string;
  baseSha: string;
  draft: boolean;
}

/**
 * Opens a draft pull request with the given files, written with the user's own token. All
 * changes land on a new branch in a single commit; the default branch is never written to.
 */
export class DocsPullRequestWriter {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call<S extends z.ZodType>(token: string, method: string, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw AppError.upstream('Could not reach GitHub');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) throw AppError.unauthorized('GitHub rejected the stored token; sign in again');
    if (response.status === 403 || response.status === 404) {
      throw new AppError(403, 'NO_WRITE_ACCESS', 'GitHub did not allow writing to this repository with your token');
    }
    if (response.status === 422) throw new AppError(422, 'GITHUB_REJECTED', 'GitHub rejected the change');
    if (!response.ok) throw AppError.upstream(`GitHub answered ${response.status}`);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw AppError.upstream('GitHub returned an unexpected shape');
    return parsed.data;
  } // prettier-ignore

  private async branchExists(input: ProposeInput, branch: string): Promise<boolean> {
    try {
      await this.call(input.token, 'GET', `/repos/${input.owner}/${input.name}/git/ref/heads/${encodeURIComponent(branch)}`, refSchema);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'NO_WRITE_ACCESS') return false;
      throw err;
    }
  } // prettier-ignore

  async propose(input: ProposeInput): Promise<Proposed> {
    const repoPath = `/repos/${input.owner}/${input.name}`;
    const repo = await this.call(input.token, 'GET', repoPath, repoSchema);
    if (repo.permissions?.push !== true) {
      throw new AppError(403, 'NO_WRITE_ACCESS', 'You cannot push to this repository, so a pull request cannot be opened from a branch in it');
    }
    const base = repo.default_branch;
    const head = await this.call(input.token, 'GET', `${repoPath}/git/ref/heads/${encodeURIComponent(base)}`, refSchema);
    const baseSha = head.object.sha;
    const baseCommit = await this.call(input.token, 'GET', `${repoPath}/git/commits/${baseSha}`, commitSchema);

    let branch = input.branch;
    for (let i = 2; await this.branchExists(input, branch); i += 1) {
      if (i > 20) throw AppError.conflict('Too many documentation branches already exist');
      branch = `${input.branch}-${i}`;
    }

    const tree = await this.call(input.token, 'POST', `${repoPath}/git/trees`, shaSchema, {
      base_tree: baseCommit.tree.sha,
      tree: input.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    const commit = await this.call(input.token, 'POST', `${repoPath}/git/commits`, shaSchema, {
      message: input.title,
      tree: tree.sha,
      parents: [baseSha],
    });
    await this.call(input.token, 'POST', `${repoPath}/git/refs`, refSchema.or(z.object({ ref: z.string() })), {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    const pull = await this.call(input.token, 'POST', `${repoPath}/pulls`, pullSchema, {
      title: input.title,
      head: branch,
      base,
      body: input.body,
      draft: true,
    });
    return { number: pull.number, url: pull.html_url, branch, base, baseSha, draft: pull.draft ?? true };
  } // prettier-ignore
}
