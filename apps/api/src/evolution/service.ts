import {
  architectureGraphSchema,
  type Activity,
  type ArchitectureEvolution,
  type Compare,
  type CompareFacts,
  type DependencyChanges,
  type FactSource,
  type Languages,
  type Quality,
  type ReleaseItem,
  type Releases,
  type ReleaseSummary as ReleaseSummaryView,
  type ReleaseSummaryRequest,
  type SnapshotCompare,
  type Timeline,
} from '@repointelligence/shared';
import { inputsOf, scoreOf } from '../analysis/service.js';
import { DOC_QUOTA, generationsToday } from '../docs/quota.js';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { LlmGateway } from '../llm/gateway.js';
import { AnalysisRun } from '../models/analysis-run.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { ReleaseSummary } from '../models/release-summary.js';
import { User } from '../models/user.js';
import {
  codeFrequencySeries,
  commitSeries,
  contributorSeries,
  issueSeries,
  pullSeries,
} from './activity.js';
import {
  releaseCadence,
  releaseItems,
  summarizeCompare,
  tagItems,
  toCommitItem,
} from './compare.js';
import { dependencyChanges } from './dependencies.js';
import { GithubHistory, STARGAZER_PAGE_LIMIT } from './github-history.js';
import {
  REGRESSION_THRESHOLDS,
  architectureHistory,
  findingChanges,
  languageHistory,
  linesByLanguage,
  qualityPoint,
  regressions,
  regressionsBetween,
  scoreDelta,
  shares,
  type LanguagePoint,
  type StoredGraph,
  type StoredRun,
} from './quality.js';
import { interpretRelease } from './release-summary.js';
import { windowWeeks } from './weeks.js';

/** Quality and language history read at most this many analysis runs. */
const MAX_RUNS = 30;
const MAX_GRAPHS = 10;

export interface EvolutionServiceOptions {
  github: GithubService;
  gateway: LlmGateway;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Target {
  owner: string;
  name: string;
  viewer?: Viewer | undefined;
}

type RunDoc = InstanceType<typeof AnalysisRun>;
type SummaryDoc = InstanceType<typeof ReleaseSummary>;

function storedRun(run: RunDoc): StoredRun | null {
  const score = scoreOf(run);
  if (!score || !run.sha || !run.finishedAt) return null;
  return { id: run.id, sha: run.sha, finishedAt: run.finishedAt, score, inputs: inputsOf(run) };
}

export class EvolutionService {
  private readonly now: () => number;

  constructor(private readonly options: EvolutionServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Confirms the caller can see the repository; GitHub answers 404 for a private one they cannot. */
  private async open(t: Target) {
    const { repo } = await this.options.github.getRepo(t.owner, t.name, t.viewer);
    const history = new GithubHistory(this.options.github, t.owner, t.name, t.viewer, {
      ...(this.options.sleep && { sleep: this.options.sleep }),
    });
    return { repo, fullName: repo.fullName.toLowerCase(), history };
  }

  private envelope<F>(fullName: string, sources: FactSource[], notes: string[], facts: F) {
    return {
      fullName,
      retrievedAt: new Date(this.now()).toISOString(),
      sources,
      notes,
      facts,
      interpretation: null,
    };
  }

  async timeline(t: Target, query: { ref?: string | undefined; page: number }): Promise<Timeline> {
    const { repo, fullName, history } = await this.open(t);
    const [commits, releases] = await Promise.all([
      history.commits(query.ref, query.page),
      history.section(() => history.releases()),
    ]);
    const notes = releases.status === 'ok' ? [] : ['Releases could not be read.'];
    return this.envelope(fullName, ['github'], notes, {
      ref: query.ref ?? repo.defaultBranch,
      page: query.page,
      hasMore: commits.length === 100 && query.page < 10,
      commits: commits.map(toCommitItem),
      releases: releases.status === 'ok' ? releaseItems(releases.data) : [],
    });
  }

  async activity(t: Target, weeks: number): Promise<Activity> {
    const { fullName, history } = await this.open(t);
    const window = windowWeeks(this.now(), weeks);
    const since = window[0] ?? this.now();
    const [commits, frequency, contributors, pulls, issues, repo] = await Promise.all([
      history.section(() => history.commitActivity()),
      history.section(() => history.codeFrequency()),
      history.section(() => history.contributorStats()),
      history.section(() => history.pullsSince(since)),
      history.section(() => history.issuesSince(since)),
      history.section(() => history.repo()),
    ]);
    const stars =
      repo.status === 'ok'
        ? await history.section(() => history.starHistory(repo.data.stargazers_count))
        : repo;

    const facts = {
      weeks,
      commits: commitSeries(commits, window),
      codeFrequency: codeFrequencySeries(frequency, window),
      contributors: contributorSeries(contributors, window),
      pullRequests: pullSeries(pulls, window),
      issues: issueSeries(issues, window),
      growth:
        repo.status === 'ok' && stars.status === 'ok'
          ? {
              status: 'ok' as const,
              reason: null,
              stars: repo.data.stargazers_count,
              forks: repo.data.forks_count,
              // GitHub's count includes open pull requests.
              openIssues: repo.data.open_issues_count,
              starPoints: [
                ...stars.data.points,
                { at: new Date(this.now()).toISOString(), stars: repo.data.stargazers_count },
              ],
              sampled: stars.data.sampled,
            }
          : {
              status: stars.status === 'ok' ? 'unavailable' as const : stars.status,
              reason: stars.status === 'ok' ? 'GitHub did not return this data' : stars.reason,
              stars: null, forks: null, openIssues: null, starPoints: [], sampled: false,
            },
    }; // prettier-ignore

    const notes: string[] = [];
    if ([commits, frequency, contributors].some((s) => s.status === 'pending')) {
      notes.push('GitHub is still computing some statistics; they appear after a refresh.');
    }
    if (facts.pullRequests.coverageStart || facts.issues.coverageStart) {
      notes.push(
        'Pull requests and issues were listed up to a cap; earlier weeks show as unknown.',
      );
    }
    if (facts.contributors.truncated) notes.push('GitHub reports only the top 100 contributors.');
    if (facts.growth.sampled)
      notes.push('Star history is sampled from a subset of stargazer pages.');
    if ((facts.growth.stars ?? 0) > STARGAZER_PAGE_LIMIT * 100) {
      notes.push('GitHub lists only the first 40,000 stargazers, so later stars are not dated.');
    }
    return this.envelope(fullName, ['github', 'computed'], notes, facts);
  }

  private async compareFacts(history: GithubHistory, base: string, head: string): Promise<{ facts: CompareFacts; notes: string[] }> {
    const raw = await history.compare(base, head);
    let dependencies: DependencyChanges;
    try {
      dependencies = await dependencyChanges(raw, base, head, (path, ref) => history.file(path, ref));
    } catch (err) {
      if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
      dependencies = { status: 'unavailable', reason: 'Manifests could not be read', manifests: [], skipped: [] };
    }
    const facts = summarizeCompare(raw, base, head, dependencies);
    const notes: string[] = [];
    if (facts.totalCommits > facts.commits.length) notes.push(`GitHub lists the first ${facts.commits.length} of ${facts.totalCommits} commits.`);
    if (facts.files.truncated) notes.push('GitHub lists at most 300 changed files; totals cover those files.');
    if (dependencies.skipped.length) notes.push(`${dependencies.skipped.length} changed manifests were not compared.`);
    return { facts, notes };
  } // prettier-ignore

  async compare(t: Target, base: string, head: string): Promise<Compare> {
    const { fullName, history } = await this.open(t);
    const { facts, notes } = await this.compareFacts(history, base, head);
    return this.envelope(fullName, ['github', 'computed'], notes, facts);
  }

  async dependencies(t: Target, base: string, head: string) {
    const { fullName, history } = await this.open(t);
    const { facts, notes } = await this.compareFacts(history, base, head);
    return this.envelope(fullName, ['github', 'computed'], notes, {
      base,
      head,
      changes: facts.dependencies,
    });
  }

  private async releaseList(history: GithubHistory): Promise<{ source: 'releases' | 'tags'; items: ReleaseItem[] }> {
    const releases = releaseItems(await history.releases());
    if (releases.length > 0) return { source: 'releases', items: releases };
    return { source: 'tags', items: tagItems(await history.tags()) };
  } // prettier-ignore

  async releases(t: Target, weeks: number): Promise<Releases> {
    const { fullName, history } = await this.open(t);
    const { source, items } = await this.releaseList(history);
    const since = windowWeeks(this.now(), weeks)[0] ?? this.now();
    const notes = source === 'tags' ? ['No releases are published; tags carry no dates.'] : [];
    return this.envelope(fullName, ['github', 'computed'], notes, {
      source,
      releases: items,
      ...releaseCadence(items, since),
    });
  }

  private async runs(fullName: string): Promise<StoredRun[]> {
    const runs = await AnalysisRun.find({ fullName, status: 'succeeded' })
      .sort({ finishedAt: -1 })
      .limit(MAX_RUNS);
    return runs
      .map(storedRun)
      .filter((r) => r !== null)
      .reverse();
  }

  async languages(t: Target): Promise<Languages> {
    const { fullName, history } = await this.open(t);
    const [runs, current] = await Promise.all([
      this.runs(fullName),
      history.section(() => history.languages()),
    ]);
    const points: LanguagePoint[] = runs.flatMap((r) => {
      const counts = linesByLanguage(r.inputs);
      return counts ? [{ at: r.finishedAt.toISOString(), sha: r.sha, source: 'analysis' as const, unit: 'lines' as const, counts }] : [];
    }); // prettier-ignore
    if (current.status === 'ok' && Object.keys(current.data).length > 0) {
      points.push({
        at: new Date(this.now()).toISOString(),
        sha: null,
        source: 'github',
        unit: 'bytes',
        counts: current.data,
      });
    }
    const analysed = points.filter((p) => p.source === 'analysis').length;
    const notes = [
      `History comes from ${analysed} analysis snapshot${analysed === 1 ? '' : 's'}${current.status === 'ok' ? ' plus the current breakdown from GitHub' : ''}.`,
    ];
    const sources: FactSource[] = analysed > 0 ? ['analysis', 'github'] : ['github'];
    return this.envelope(fullName, sources, notes, languageHistory(points));
  }

  async quality(t: Target): Promise<Quality> {
    const { fullName } = await this.open(t);
    const points = (await this.runs(fullName)).map(qualityPoint);
    const notes =
      points.length < 2 ? ['Trends and regressions appear after a second analysis.'] : [];
    return this.envelope(fullName, ['analysis', 'computed'], notes, {
      points,
      regressions: regressions(points),
      thresholds: { ...REGRESSION_THRESHOLDS },
    });
  }

  async snapshotCompare(t: Target, a: string, b: string): Promise<SnapshotCompare> {
    const { fullName } = await this.open(t);
    const load = async (id: string) => {
      const run = await AnalysisRun.findOne({ _id: id, fullName, status: 'succeeded' });
      const stored = run ? storedRun(run) : null;
      if (!stored) throw AppError.notFound('Analysis snapshot not found for this repository');
      return stored;
    };
    const [ra, rb] = await Promise.all([load(a), load(b)]);
    const [pa, pb] = [qualityPoint(ra), qualityPoint(rb)];
    const la = linesByLanguage(ra.inputs);
    const lb = linesByLanguage(rb.inputs);
    const truncated = [ra, rb].some((r) => Object.keys(r.score.findingsTruncated).length > 0);
    return this.envelope(
      fullName,
      ['analysis', 'computed'],
      truncated ? ['Only findings kept on each score are matched; the rest are counted, not listed.'] : [],
      {
        a: pa,
        b: pb,
        delta: scoreDelta(pa, pb),
        findings: findingChanges(ra.score.findings, rb.score.findings),
        languages: { a: la ? shares(la) : null, b: lb ? shares(lb) : null },
        regressions: regressionsBetween(pa, pb),
      },
    );
  } // prettier-ignore

  async architecture(t: Target): Promise<ArchitectureEvolution> {
    const { fullName } = await this.open(t);
    const docs = await ArchitectureGraphModel.find({ fullName })
      .sort({ computedAt: -1 })
      .limit(MAX_GRAPHS);
    const graphs: StoredGraph[] = docs.reverse().flatMap((doc) => {
      const parsed = architectureGraphSchema.safeParse(doc.graph);
      return parsed.success ? [{ sha: doc.sha, computedAt: doc.computedAt, graph: parsed.data }] : [];
    }); // prettier-ignore
    const notes =
      graphs.length < 2 ? ['Changes appear once graphs exist for at least two commits.'] : [];
    return this.envelope(fullName, ['graph', 'computed'], notes, architectureHistory(graphs));
  }

  // ---- release summaries --------------------------------------------------------------------------

  async releaseSummary(
    t: Target,
    request: ReleaseSummaryRequest,
    userId: string,
  ): Promise<ReleaseSummaryView> {
    const { repo, fullName, history } = await this.open(t);
    const base = request.base ?? null;
    const key = { fullName, tag: request.tag, base, ...(repo.private && { createdBy: userId }) };
    const existing = await ReleaseSummary.findOne(key).sort({ generatedAt: -1 });
    if (existing && !request.force) return toReleaseSummaryView(existing, true);
    if ((await generationsToday(userId, this.now())) >= DOC_QUOTA.dailyGenerations) {
      throw AppError.quotaExceeded(
        `You have used today's ${DOC_QUOTA.dailyGenerations} generations`,
      );
    }

    const { items } = await this.releaseList(history);
    const index = items.findIndex((r) => r.tag === request.tag);
    if (index === -1) throw AppError.notFound('No release or tag with that name');
    const release = items[index];
    const compareWith = base ?? items[index + 1]?.tag ?? null;
    const compared = compareWith
      ? await this.compareFacts(history, compareWith, request.tag)
      : null;

    let result: Awaited<ReturnType<typeof interpretRelease>> = {
      interpretation: null,
      note: 'This is the first release, so there is nothing to compare it with.',
    };
    if (compared) {
      const allowed = !repo.private || (await User.findById(userId))?.preferences.allowPrivateRepoLlm === true;
      result = allowed
        ? await interpretRelease(this.options.gateway, request.tag, compareWith, compared.facts, {
            privateContent: repo.private,
            userId,
            fullName,
            now: this.now(),
          })
        : { interpretation: null, note: 'Model use for private repositories is off. Turn it on in Settings.' };
    } // prettier-ignore

    const doc = await ReleaseSummary.create({
      fullName,
      tag: request.tag,
      base,
      createdBy: userId,
      private: repo.private,
      facts: {
        tag: request.tag,
        base: compareWith,
        publishedAt: release?.publishedAt ?? null,
        compare: compared?.facts ?? null,
      },
      interpretation: result.interpretation,
      interpretationNote: result.note,
      charged: result.interpretation !== null,
      generatedAt: new Date(this.now()),
    });
    return toReleaseSummaryView(doc, false, compared?.notes ?? []);
  }
}

export function toReleaseSummaryView(
  doc: SummaryDoc,
  reused: boolean,
  notes: string[] = [],
): ReleaseSummaryView {
  const facts = doc.facts as ReleaseSummaryView['facts'];
  return {
    id: doc.id,
    fullName: doc.fullName,
    retrievedAt: doc.generatedAt.toISOString(),
    sources: facts.compare ? ['github', 'computed'] : ['github'],
    notes,
    facts,
    interpretation: (doc.interpretation ?? null) as ReleaseSummaryView['interpretation'],
    interpretationNote: doc.interpretationNote ?? null,
    reused,
  };
}
