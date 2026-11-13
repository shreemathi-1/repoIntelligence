import {
  MAX_PLANS_PER_REPO,
  planTaskSchema,
  type ImplementationPlan as PlanView,
  type LearningMode,
  type Onboarding,
  type PlanList,
  type PlanTask,
  type StarterIssues,
} from '@repointelligence/shared';
import { z } from 'zod';
import { detect } from '../adaptability/requirements.js';
import { classifyLicense } from '../discovery/license.js';
import type { DiscoveryService } from '../discovery/service.js';
import { loadFacts, type Facts } from '../docs/facts.js';
import { DOC_QUOTA, generationsToday } from '../docs/quota.js';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { GraphService } from '../graph/service.js';
import { isObjectId, latestReadableRun } from '../ingest/access.js';
import type { IngestionService } from '../ingest/service.js';
import type { LlmGateway } from '../llm/gateway.js';
import { ImplementationPlan } from '../models/implementation-plan.js';
import type { IngestionRun } from '../models/ingestion-run.js';
import { OnboardingProgress } from '../models/onboarding-progress.js';
import { User } from '../models/user.js';
import type { HybridRetriever } from '../rag/retrieve.js';
import { planIssue, planMarkdown } from './export.js';
import { buildOnboarding, onboardingChecklist, starterCandidates } from './onboarding.js';
import { buildTasks, indexRepo } from './pipeline.js';
import { filesOnlyProposal, findCandidates, proposePlan } from './propose.js';

export interface PlannerServiceOptions {
  github: GithubService;
  graphs: GraphService;
  ingestion: IngestionService;
  discovery: DiscoveryService;
  gateway: LlmGateway;
  retriever: HybridRetriever;
  now?: () => number;
}

interface Target {
  owner: string;
  name: string;
  userId?: string | undefined;
  viewer?: Viewer | undefined;
}

type RunDoc = InstanceType<typeof IngestionRun>;
type PlanDoc = InstanceType<typeof ImplementationPlan>;

const RISK_ORDER = ['low', 'medium', 'high'] as const;
const round = (n: number): number => Math.round(n * 10) / 10;

export class PlannerService {
  private readonly now: () => number;

  constructor(private readonly options: PlannerServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private async load(target: Target): Promise<{ run: RunDoc; facts: Facts }> {
    const run = await latestReadableRun(`${target.owner}/${target.name}`, target.userId);
    if (!run) throw AppError.notFound('Ingest this repository first');
    return { run, facts: await loadFacts(this.options, run, target.viewer) };
  }

  // ---- onboarding ----------------------------------------------------------------------------------

  async onboarding(target: Target, mode: LearningMode): Promise<Onboarding> {
    const { facts } = await this.load(target);
    // The license plays no part in onboarding; the collector only carries it through.
    const detected = await detect(facts, classifyLicense('NOASSERTION'));
    const built = await buildOnboarding(facts, detected, mode);
    const progress = target.userId
      ? await OnboardingProgress.findOne({ user: target.userId, fullName: facts.fullName })
      : null;
    return { ...built, ...onboardingChecklist(built, progress?.done ?? []) };
  }

  async setOnboardingProgress(target: Target, userId: string, done: string[]): Promise<void> {
    const run = await latestReadableRun(`${target.owner}/${target.name}`, userId);
    if (!run) throw AppError.notFound('Ingest this repository first');
    await OnboardingProgress.updateOne(
      { user: userId, fullName: run.fullName },
      { $set: { done: [...new Set(done)] } },
      { upsert: true },
    );
  }

  async starterIssues(target: Target): Promise<StarterIssues> {
    const { facts } = await this.load(target);
    const notes: string[] = [];
    let github: StarterIssues['github'] = [];
    try {
      const found = await this.options.discovery.contribute({ repo: facts.repo.fullName, page: 1 }, target.viewer);
      github = found.items.slice(0, 10);
    } catch (err) {
      if (!(err instanceof AppError) || err.code === 'RATE_LIMITED') throw err;
      notes.push('Open issues could not be read from GitHub.');
    }
    if (!facts.graph) notes.push('No architecture graph exists for this commit, so files without tests are not listed.');
    return { fullName: facts.fullName, sha: facts.sha, github, candidates: starterCandidates(facts), notes };
  } // prettier-ignore

  // ---- feature plans -------------------------------------------------------------------------------

  async createPlan(target: Target, userId: string, goal: string): Promise<PlanView> {
    const { run, facts } = await this.load({ ...target, userId });
    if ((await ImplementationPlan.countDocuments({ createdBy: userId, fullName: run.fullName })) >= MAX_PLANS_PER_REPO) {
      throw AppError.badRequest(`You can keep up to ${MAX_PLANS_PER_REPO} plans per repository. Delete one first.`);
    }
    const candidates = await findCandidates(this.options.retriever, goal, {
      fullName: run.fullName,
      sha: run.sha,
      graph: facts.graph,
      useVectors: run.embedding.status === 'ready',
    });
    const notes: string[] = [];
    if (!facts.graph) notes.push('No architecture graph exists for this commit, so tasks are ordered by directory and dependants are unknown.');
    if (candidates.length === 0) notes.push('Nothing in the ingested files matched the goal; try naming a feature, file or route.');

    const allowed = !run.private || (await User.findById(userId))?.preferences.allowPrivateRepoLlm === true;
    let proposal: Awaited<ReturnType<typeof proposePlan>> = { tasks: null, writtenBy: null, note: 'Model use for private repositories is off, so the plan lists the relevant files only. Turn it on in Settings.' };
    if (allowed && candidates.length > 0) {
      if ((await generationsToday(userId, this.now())) >= DOC_QUOTA.dailyGenerations) {
        throw AppError.quotaExceeded(`You have used today's ${DOC_QUOTA.dailyGenerations} generations`);
      }
      proposal = await proposePlan(this.options.gateway, { goal, fullName: run.fullName, sha: run.sha, graph: facts.graph, paths: facts.paths, candidates, privateContent: run.private, userId });
    }
    if (proposal.note && candidates.length > 0) notes.push(proposal.note);

    const index = indexRepo(facts.paths, facts.graph);
    let built = buildTasks(proposal.tasks ?? filesOnlyProposal(candidates), index);
    let origin: PlanView['origin'] = proposal.tasks ? 'model' : 'files-only';
    if (proposal.tasks && built.tasks.length === 0) {
      // Nothing the model proposed matched the repository; fall back to the files themselves.
      notes.push('None of the proposed tasks referred to files in this repository, so the plan lists the relevant files only.');
      built = { tasks: buildTasks(filesOnlyProposal(candidates), index).tasks, dropped: built.dropped };
      origin = 'files-only';
    }
    const doc = await ImplementationPlan.create({
      fullName: run.fullName,
      sha: run.sha,
      createdBy: userId,
      private: run.private,
      goal,
      origin,
      writtenBy: origin === 'model' ? proposal.writtenBy : null,
      notes,
      dropped: built.dropped,
      relevantFiles: candidates.map((c) => ({ path: c.path, line: c.excerpts[0]?.startLine ?? null, why: 'Matched the goal in retrieval.' })),
      tasks: built.tasks,
      generatedAt: new Date(this.now()),
    });
    return toPlanView(doc);
  } // prettier-ignore

  async plans(target: Target, userId: string): Promise<PlanList> {
    const fullName = `${target.owner}/${target.name}`.toLowerCase();
    const docs = await ImplementationPlan.find({ createdBy: userId, fullName }).sort({ generatedAt: -1 });
    return {
      plans: docs.map((doc) => {
        const { id, goal, sha, generatedAt, origin, progress } = toPlanView(doc);
        return { id, goal, sha, generatedAt, origin, progress };
      }),
      limit: MAX_PLANS_PER_REPO,
    };
  } // prettier-ignore

  private async own(id: string, userId: string): Promise<PlanDoc> {
    const doc = isObjectId(id) ? await ImplementationPlan.findOne({ _id: id, createdBy: userId }) : null;
    if (!doc) throw AppError.notFound('Plan not found');
    return doc;
  } // prettier-ignore

  async plan(id: string, userId: string): Promise<PlanView> {
    return toPlanView(await this.own(id, userId));
  }

  async deletePlan(id: string, userId: string): Promise<void> {
    await (await this.own(id, userId)).deleteOne();
  }

  async setPlanProgress(id: string, userId: string, done: string[]): Promise<PlanView> {
    const doc = await this.own(id, userId);
    const known = new Set(toPlanView(doc).tasks.map((t) => t.id));
    doc.done = [...new Set(done.filter((d) => known.has(d)))];
    await doc.save();
    return toPlanView(doc);
  }

  async exportPlan(id: string, userId: string, format: 'markdown' | 'issue') {
    const plan = await this.plan(id, userId);
    const base = `${plan.fullName.replace('/', '-')}-plan-${plan.sha.slice(0, 7)}`;
    return format === 'issue'
      ? { filename: `${base}-issue.md`, body: planIssue(plan) }
      : { filename: `${base}.md`, body: planMarkdown(plan) };
  }
}

const storedSchema = z.object({
  dropped: z.object({ tasks: z.number(), files: z.number() }),
  relevantFiles: z.array(z.object({ path: z.string(), line: z.number().nullable(), why: z.string() })),
  tasks: z.array(planTaskSchema),
}); // prettier-ignore

export function toPlanView(doc: PlanDoc): PlanView {
  const stored = storedSchema.parse({ dropped: doc.dropped as unknown, relevantFiles: doc.relevantFiles as unknown, tasks: doc.tasks as unknown });
  const tasks: PlanTask[] = stored.tasks.map((t) => ({ ...t, done: doc.done.includes(t.id) }));
  const worst = Math.max(0, ...tasks.map((t) => RISK_ORDER.indexOf(t.risk.level)));
  return {
    id: doc.id,
    fullName: doc.fullName,
    sha: doc.sha,
    goal: doc.goal,
    generatedAt: doc.generatedAt.toISOString(),
    origin: doc.origin,
    writtenBy: doc.writtenBy ?? null,
    notes: doc.notes,
    dropped: stored.dropped,
    relevantFiles: stored.relevantFiles,
    tasks,
    totals: {
      effort: { low: round(tasks.reduce((s, t) => s + t.effort.low, 0)), high: round(tasks.reduce((s, t) => s + t.effort.high, 0)) },
      risk: RISK_ORDER[worst] ?? 'low',
      files: new Set(tasks.flatMap((t) => t.files.map((f) => f.path))).size,
    },
    progress: { done: tasks.filter((t) => t.done).length, total: tasks.length },
  };
} // prettier-ignore
