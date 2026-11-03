import { z } from 'zod';
import type { Citation, DocDrift, DocSection } from '@repointelligence/shared';
import type { GithubService, Viewer } from '../github/service.js';

const compareSchema = z.object({
  ahead_by: z.number().int().nonnegative(),
  files: z
    .array(z.object({ filename: z.string(), previous_filename: z.string().optional() }))
    .default([]),
});

/** Which of a document's cited files changed between its commit and a newer one. */
export async function detectDrift(
  github: GithubService,
  doc: { id: string; fullName: string; sha: string; sections: DocSection[]; citations: Citation[] },
  latestSha: string | null,
  viewer?: Viewer,
): Promise<DocDrift> {
  const base: DocDrift = {
    docId: doc.id,
    docSha: doc.sha,
    latestSha,
    status: 'unknown',
    changedFiles: [],
    sections: [],
    commitsBehind: null,
  };
  if (!latestSha) return base;
  if (latestSha === doc.sha) return { ...base, status: 'current', commitsBehind: 0 };
  const [owner = '', name = ''] = doc.fullName.split('/');
  const { data } = await github.getJson(
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      params: { owner, repo: name, basehead: `${doc.sha}...${latestSha}` },
      schema: compareSchema,
      // Both ends are commits, so the answer never changes.
      freshMs: 24 * 3_600_000,
    },
    viewer,
  );
  const changed = new Set(data.files.flatMap((f) => [f.filename, f.previous_filename ?? '']));
  const cited = new Set(doc.citations.map((c) => c.path));
  const changedFiles = [...cited].filter((p) => changed.has(p)).sort();
  const sections = doc.sections
    .map((s) => ({
      id: s.id,
      heading: s.heading,
      changedSources: [...new Set(s.citations.map((c) => c.path))].filter((p) => changed.has(p)),
    }))
    .filter((s) => s.changedSources.length > 0);
  return {
    ...base,
    status: changedFiles.length > 0 ? 'drifted' : 'current',
    changedFiles,
    sections,
    commitsBehind: data.ahead_by,
  };
}
