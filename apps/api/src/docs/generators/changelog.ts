import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { GithubService, Viewer } from '../../github/service.js';
import type { LlmGateway } from '../../llm/gateway.js';
import { DATA_RULES, noteBlock } from '../../llm/prompts.js';
import { completeStructured } from '../../llm/structured.js';
import type { Facts } from '../facts.js';
import { section, type DocPlan, type GenerateOptions } from '../plan.js';

export const MAX_CHANGELOG_COMMITS = 250;

const tagsSchema = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) }));
const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string().optional(),
  commit: z.object({
    message: z.string(),
    author: z.object({ date: z.string().optional() }).nullable().optional(),
  }),
});
const compareSchema = z.object({
  commits: z.array(commitSchema).default([]),
  total_commits: z.number().optional(),
});
const listSchema = z.array(commitSchema);

export const GROUPS = ['breaking', 'feat', 'fix', 'perf', 'docs', 'refactor', 'other'] as const;
type Group = (typeof GROUPS)[number];
const GROUP_TITLES: Record<Group, string> = {
  breaking: 'Breaking changes',
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Performance',
  docs: 'Documentation',
  refactor: 'Changed',
  other: 'Other',
};
const SKIP = /^(chore|ci|build|test|style)(\(|!|:)/;
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

export interface Entry {
  sha: string;
  subject: string;
  scope: string | null;
  group: Group;
  pr: number | null;
  conventional: boolean;
}

export function parseCommit(sha: string, message: string): Entry | null {
  const [header = '', ...body] = message.split('\n');
  if (/^Merge (branch|remote-tracking)/.test(header)) return null;
  if (SKIP.test(header)) return null;
  const pr = /\(#(\d+)\)\s*$/.exec(header) ?? /^Merge pull request #(\d+)/.exec(header);
  const m = CONVENTIONAL.exec(header);
  const breaking = Boolean(m?.[3]) || body.some((l) => /^BREAKING[ -]CHANGE:/.test(l));
  const type = m?.[1]?.toLowerCase() ?? '';
  const group: Group = breaking ? 'breaking' : (GROUPS as readonly string[]).includes(type) ? (type as Group) : 'other';
  const subject = (m?.[4] ?? header).replace(/\s*\(#\d+\)\s*$/, '').trim();
  return { sha, subject, scope: m?.[2] ?? null, group, pr: pr?.[1] ? Number(pr[1]) : null, conventional: Boolean(m) };
} // prettier-ignore

const classifySchema = z.object({
  items: z.array(z.object({ index: z.number().int().min(0), group: z.enum(GROUPS) })).max(200),
});

/** Sorts commits that do not follow Conventional Commits, with a small model when one is available. */
async function classify(gateway: LlmGateway, entries: Entry[], options: { privateContent: boolean; userId: string; fullName: string }) {
  const loose = entries.filter((e) => !e.conventional).slice(0, 80);
  if (loose.length === 0 || !gateway.available('light', options)) return;
  try {
    const { data } = await completeStructured(
      gateway,
      'light',
      [
        { role: 'system', content: `Classify commit messages for a changelog. ${DATA_RULES} Groups: feat (new feature), fix (bug fix), perf, docs, refactor (behaviour-neutral change), breaking, other. Reply with JSON: {"items": [{"index": 0, "group": "feat"}]}.` },
        { role: 'user', content: noteBlock('commits', loose.map((e, i) => `${i}: ${e.subject}`).join('\n')) },
      ],
      classifySchema,
      { ...options },
    );
    for (const item of data.items) {
      const entry = loose[item.index];
      if (entry) entry.group = item.group;
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
} // prettier-ignore

export function changelogGenerator(deps: {
  github: GithubService;
  gateway: LlmGateway;
  viewer?: Viewer;
  userId: string;
  privateContent: boolean | null;
}) {
  return async (facts: Facts, options: GenerateOptions): Promise<DocPlan> => {
    const { owner, name } = facts;
    const to = options.to ?? facts.sha;
    let from = options.from ?? null;
    let fromLabel = from;
    if (!from) {
      const { data: tags } = await deps.github.getJson(
        { route: 'GET /repos/{owner}/{repo}/tags', params: { owner, repo: name, per_page: 100 }, schema: tagsSchema, freshMs: 10 * 60_000 },
        deps.viewer,
      );
      const tag = tags.find((t) => t.commit.sha !== to);
      from = tag?.commit.sha ?? null;
      fromLabel = tag?.name ?? null;
    }
    const commits = from
      ? (await deps.github.getJson(
          { route: 'GET /repos/{owner}/{repo}/compare/{basehead}', params: { owner, repo: name, basehead: `${from}...${to}`, per_page: MAX_CHANGELOG_COMMITS }, schema: compareSchema, freshMs: 10 * 60_000 },
          deps.viewer,
        )).data.commits
      : (await deps.github.getJson(
          { route: 'GET /repos/{owner}/{repo}/commits', params: { owner, repo: name, sha: to, per_page: 100 }, schema: listSchema, freshMs: 10 * 60_000 },
          deps.viewer,
        )).data;
    const entries = commits
      .slice(-MAX_CHANGELOG_COMMITS)
      .map((c) => parseCommit(c.sha, c.commit.message))
      .filter((e): e is Entry => e !== null);
    if (deps.privateContent !== null) {
      await classify(deps.gateway, entries, { privateContent: deps.privateContent, userId: deps.userId, fullName: facts.fullName });
    }
    const link = (e: Entry) =>
      `[${e.sha.slice(0, 7)}](https://github.com/${facts.fullName}/commit/${e.sha})${e.pr ? `, [#${e.pr}](https://github.com/${facts.fullName}/pull/${e.pr})` : ''}`;
    const groups = GROUPS.map((g) => ({ g, items: entries.filter((e) => e.group === g) })).filter((x) => x.items.length > 0);
    const range = `${fromLabel ?? 'the first listed commit'} → ${to === facts.sha ? to.slice(0, 7) : to}`;
    const heading = `Unreleased (${range})`;
    return {
      title: 'Changelog',
      sections: [
        section('highlights', heading, {
          prose: 'Write two or three sentences of release notes highlighting the most important changes for users. Do not cite files.',
          notes: entries.slice(0, 120).map((e) => `[${e.group}] ${e.scope ? `${e.scope}: ` : ''}${e.subject}`).join('\n'),
          facts: groups.map(({ g, items }) => `### ${GROUP_TITLES[g]}\n\n${items.map((e) => `- ${e.scope ? `**${e.scope}:** ` : ''}${e.subject} (${link(e)})`).join('\n')}`).join('\n\n'),
          ...(entries.length === 0 && { missing: 'no user-facing commits in this range' }),
        }),
      ],
      notes: [
        `${commits.length} commits from ${range}${commits.length >= MAX_CHANGELOG_COMMITS ? `, capped at ${MAX_CHANGELOG_COMMITS}` : ''}. Chores, CI, build, test and style commits are left out.`,
      ],
    };
  };
} // prettier-ignore
