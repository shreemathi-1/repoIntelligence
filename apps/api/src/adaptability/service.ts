import { createHash } from 'node:crypto';
import semver from 'semver';
import {
  MAX_STACK_PROFILES,
  adaptabilityFactsSchema,
  stackProfileInputSchema,
  type AdaptabilityReport as ReportView,
  type Alternatives,
  type EvaluateRequest,
  type ParsedManifest,
  type Runtime,
  type StackProfile as ProfileView,
  type StackProfileInput,
} from '@repointelligence/shared';
import type { DiscoveryService } from '../discovery/service.js';
import { loadFacts } from '../docs/facts.js';
import { DOC_QUOTA, generationsToday } from '../docs/quota.js';
import { toHtml } from '../docs/render.js';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { GraphService } from '../graph/service.js';
import { isObjectId, latestReadableRun } from '../ingest/access.js';
import { parseManifest } from '../ingest/manifests.js';
import type { IngestionService } from '../ingest/service.js';
import type { LlmGateway } from '../llm/gateway.js';
import { AdaptabilityReport } from '../models/adaptability-report.js';
import { StackProfile } from '../models/stack-profile.js';
import { User } from '../models/user.js';
import { pickAlternatives } from './alternatives.js';
import { buildChecklist, evaluate } from './evaluate.js';
import { explainReport } from './explain.js';
import { toMarkdown } from './report.js';
import { detect } from './requirements.js';
import { toRange } from './versions.js';

export interface AdaptabilityServiceOptions {
  github: GithubService;
  graphs: GraphService;
  ingestion: IngestionService;
  discovery: DiscoveryService;
  gateway: LlmGateway;
  now?: () => number;
}

interface Target {
  owner: string;
  name: string;
  userId?: string | undefined;
  viewer?: Viewer | undefined;
}

type ProfileDoc = InstanceType<typeof StackProfile>;
type ReportDoc = InstanceType<typeof AdaptabilityReport>;

const RUNTIME_OF = { npm: 'node', pypi: 'python', maven: 'java', go: 'go' } as const;

function toProfileView(doc: ProfileDoc): ProfileView {
  return {
    ...stackProfileInputSchema.parse(doc.answers),
    id: doc.id,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class AdaptabilityService {
  private readonly now: () => number;

  constructor(private readonly options: AdaptabilityServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  // ---- stack profiles ------------------------------------------------------------------------------

  async profiles(userId: string): Promise<ProfileView[]> {
    const docs = await StackProfile.find({ user: userId }).sort({ updatedAt: -1 });
    return docs.map(toProfileView);
  }

  async createProfile(userId: string, input: StackProfileInput): Promise<ProfileView> {
    if ((await StackProfile.countDocuments({ user: userId })) >= MAX_STACK_PROFILES) {
      throw AppError.badRequest(`You can save up to ${MAX_STACK_PROFILES} stack profiles`);
    }
    return toProfileView(await StackProfile.create({ user: userId, name: input.name, answers: input }));
  } // prettier-ignore

  private async ownProfile(userId: string, id: string): Promise<ProfileDoc> {
    const doc = isObjectId(id) ? await StackProfile.findOne({ _id: id, user: userId }) : null;
    if (!doc) throw AppError.notFound('Stack profile not found');
    return doc;
  }

  async updateProfile(userId: string, id: string, input: StackProfileInput): Promise<ProfileView> {
    const doc = await this.ownProfile(userId, id);
    doc.name = input.name;
    doc.set('answers', input);
    await doc.save();
    return toProfileView(doc);
  }

  async deleteProfile(userId: string, id: string): Promise<void> {
    await (await this.ownProfile(userId, id)).deleteOne();
  }

  /** Reads a pasted manifest into profile fields. Nothing is stored. */
  parseManifest(filename: string, content: string): ParsedManifest {
    const manifest = parseManifest(content, filename.split(/[\\/]/).pop() ?? filename);
    if (!manifest) {
      throw AppError.badRequest('Paste a package.json, requirements.txt, pyproject.toml, pom.xml or go.mod');
    }
    const runtime: Runtime = RUNTIME_OF[manifest.ecosystem];
    const declared = manifest.engines[runtime];
    const range = declared ? toRange(runtime, declared) : null;
    // A range is not a version; the lowest version it allows is the safest reading of "what I run".
    const lowest = range && range !== '*' ? semver.minVersion(range)?.version : undefined;
    return {
      ecosystem: manifest.ecosystem,
      runtimes: lowest ? { [runtime]: lowest } : {},
      dependencies: manifest.dependencies
        .filter((d) => d.name.length <= 80 && d.spec.length <= 60)
        .slice(0, 300)
        .map((d) => ({ name: d.name, version: d.spec, ecosystem: manifest.ecosystem })),
    };
  } // prettier-ignore

  // ---- evaluation ----------------------------------------------------------------------------------

  private async resolveProfile(request: EvaluateRequest, userId: string | undefined): Promise<StackProfileInput> {
    if ('profile' in request) return request.profile;
    if (!userId) throw AppError.unauthorized('Sign in to use a saved stack profile');
    return stackProfileInputSchema.parse((await this.ownProfile(userId, request.profileId)).answers);
  } // prettier-ignore

  /**
   * Compares the repository at its latest ingested commit with a stack. Signed-in users get a
   * stored report; an anonymous evaluation is returned and forgotten.
   */
  async evaluate(target: Target, request: EvaluateRequest): Promise<ReportView> {
    const profile = await this.resolveProfile(request, target.userId);
    const run = await latestReadableRun(`${target.owner}/${target.name}`, target.userId);
    if (!run) throw AppError.notFound('Ingest this repository before evaluating it');
    const [facts, card] = await Promise.all([
      loadFacts(this.options, run, target.viewer),
      this.options.discovery.repoCard(target.owner, target.name, target.viewer),
    ]);
    const detected = await detect(facts, card.license);
    const result = evaluate(detected, profile);
    const notes = [
      ...(result.inputs.graph ? [] : ['No architecture graph exists for this commit, so models, auth and frameworks were read from manifests only.']),
      ...(facts.paths.length === 0 ? ['The file list could not be read, so file-based checks are incomplete.'] : []),
    ]; // prettier-ignore
    const generatedAt = new Date(this.now());

    if (!target.userId) {
      return {
        id: null,
        fullName: run.fullName,
        sha: run.sha,
        profile,
        generatedAt: generatedAt.toISOString(),
        notes,
        facts: result,
        checklist: buildChecklist(result, run.sha),
        interpretation: null,
        interpretationNote: null,
      };
    }
    const profileHash = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const key = { fullName: run.fullName, sha: run.sha, createdBy: target.userId, profileHash };
    // An explanation describes one set of results; when they change it no longer applies.
    const previous = await AdaptabilityReport.findOne(key);
    const changed = previous !== null && JSON.stringify(previous.facts) !== JSON.stringify(result);
    const doc = await AdaptabilityReport.findOneAndUpdate(
      key,
      {
        $set: {
          profile,
          facts: result,
          notes,
          private: run.private,
          generatedAt,
          ...(changed && { interpretation: null, interpretationNote: null }),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    return toReportView(doc);
  }

  private async own(id: string, userId: string): Promise<ReportDoc> {
    const doc = isObjectId(id) ? await AdaptabilityReport.findOne({ _id: id, createdBy: userId }) : null;
    if (!doc) throw AppError.notFound('Report not found');
    return doc;
  } // prettier-ignore

  async get(id: string, userId: string): Promise<ReportView> {
    return toReportView(await this.own(id, userId));
  }

  async setChecklist(id: string, userId: string, done: string[]): Promise<ReportView> {
    const doc = await this.own(id, userId);
    const known = new Set(toReportView(doc).checklist.map((c) => c.id));
    doc.done = [...new Set(done.filter((d) => known.has(d)))];
    await doc.save();
    return toReportView(doc);
  }

  /** Adds a model's explanation of the stored rule results. The results themselves do not change. */
  async explain(id: string, userId: string): Promise<ReportView> {
    const doc = await this.own(id, userId);
    if (doc.interpretation) return toReportView(doc);
    const view = toReportView(doc);
    const allowed = !doc.private || (await User.findById(userId))?.preferences.allowPrivateRepoLlm === true;
    if (!allowed) {
      doc.interpretationNote = 'Model use for private repositories is off. Turn it on in Settings.';
      await doc.save();
      return toReportView(doc);
    }
    if ((await generationsToday(userId, this.now())) >= DOC_QUOTA.dailyGenerations) {
      throw AppError.quotaExceeded(`You have used today's ${DOC_QUOTA.dailyGenerations} generations`);
    }
    const result = await explainReport(this.options.gateway, view.facts, view.profile, {
      privateContent: doc.private,
      userId,
      fullName: doc.fullName,
      now: this.now(),
    });
    doc.set('interpretation', result.interpretation);
    doc.interpretationNote = result.note;
    if (result.interpretation) doc.explainedAt = new Date(this.now());
    await doc.save();
    return toReportView(doc);
  } // prettier-ignore

  async export(id: string, userId: string, format: 'markdown' | 'html' | 'json') {
    const report = await this.get(id, userId);
    const base = `${report.fullName.replace('/', '-')}-readiness-${report.sha.slice(0, 7)}`;
    if (format === 'json') {
      return { type: 'application/json', filename: `${base}.json`, body: JSON.stringify(report, null, 2) };
    }
    const markdown = toMarkdown(report);
    return format === 'html'
      ? { type: 'text/html', filename: `${base}.html`, body: toHtml(markdown, `Integration readiness: ${report.fullName}`) }
      : { type: 'text/markdown', filename: `${base}.md`, body: markdown };
  } // prettier-ignore

  async alternatives(target: Target, request: EvaluateRequest): Promise<Alternatives> {
    const profile = await this.resolveProfile(request, target.userId);
    const similar = await this.options.discovery.similar(target.owner, target.name, target.viewer);
    return pickAlternatives(similar, profile);
  }
}

export function toReportView(doc: ReportDoc): ReportView {
  const facts = adaptabilityFactsSchema.parse(doc.facts);
  return {
    id: doc.id,
    fullName: doc.fullName,
    sha: doc.sha,
    profile: stackProfileInputSchema.parse(doc.profile),
    generatedAt: doc.generatedAt.toISOString(),
    notes: doc.notes,
    facts,
    checklist: buildChecklist(facts, doc.sha, doc.done),
    interpretation: (doc.interpretation ?? null) as ReportView['interpretation'],
    interpretationNote: doc.interpretationNote ?? null,
  };
}
