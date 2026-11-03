import {
  DOC_LABELS,
  DOC_TARGETS,
  type DocDrift,
  type DocKind,
  type DocPullRequest as DocPullRequestView,
  type DocQuota,
  type DocReview,
  type GeneratedDoc as GeneratedDocView,
  type MissingDocs,
} from '@repointelligence/shared';
import { canWrite } from '../auth/github-oauth.js';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { GraphService } from '../graph/service.js';
import { isObjectId, latestReadableRun, mayUseModels } from '../ingest/access.js';
import type { IngestionService } from '../ingest/service.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DocPullRequest } from '../models/doc-pull-request.js';
import { GeneratedDoc } from '../models/generated-doc.js';
import type { IngestionRun } from '../models/ingestion-run.js';
import { User } from '../models/user.js';
import { composeDoc, uniqueCitations } from './compose.js';
import { detectDrift } from './drift.js';
import { loadFacts, type Facts } from './facts.js';
import { architectureDoc, sequenceDoc } from './generators/architecture.js';
import { changelogGenerator } from './generators/changelog.js';
import {
  contributingDoc,
  deploymentDoc,
  readmeDoc,
  setupDoc,
  troubleshootingDoc,
} from './generators/guides.js';
import { apiDoc, databaseDoc, docstringsDoc, envDoc } from './generators/reference.js';
import { findMissingDocs } from './missing.js';
import type { GenerateOptions, Generator } from './plan.js';
import { DocsPullRequestWriter } from './pull-request.js';
import { linkCitations, toHtml, type LinkMode } from './render.js';
import { reviewDoc } from './review.js';

export const DOC_QUOTA = { dailyGenerations: 10 } as const;

const STATIC: Record<Exclude<DocKind, 'changelog'>, Generator> = {
  readme: readmeDoc,
  setup: setupDoc,
  env: envDoc,
  api: apiDoc,
  architecture: architectureDoc,
  database: databaseDoc,
  docstrings: docstringsDoc,
  contributing: contributingDoc,
  troubleshooting: troubleshootingDoc,
  sequence: sequenceDoc,
  deployment: deploymentDoc,
};

type DocDoc = InstanceType<typeof GeneratedDoc>;
type RunDoc = InstanceType<typeof IngestionRun>;

export interface DocsServiceOptions {
  github: GithubService;
  graphs: GraphService;
  ingestion: IngestionService;
  gateway: LlmGateway;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GenerateInput extends GenerateOptions {
  owner: string;
  name: string;
  kind: DocKind;
  force?: boolean;
  userId: string;
  viewer?: Viewer;
}

export class DocsService {
  private readonly now: () => number;
  private readonly writer: DocsPullRequestWriter;

  constructor(private readonly options: DocsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.writer = new DocsPullRequestWriter(options.fetch);
  }

  private async run(fullName: string, userId: string | undefined): Promise<RunDoc> {
    const run = await latestReadableRun(fullName, userId);
    if (!run) throw AppError.notFound('Ingest this repository before generating documentation');
    return run;
  }

  private facts(run: RunDoc, viewer?: Viewer): Promise<Facts> {
    return loadFacts(this.options, run, viewer);
  }

  private async generationsToday(userId: string): Promise<number> {
    const dayStart = new Date(this.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    return GeneratedDoc.countDocuments({ createdBy: userId, generatedAt: { $gte: dayStart } });
  }

  async quota(userId: string): Promise<DocQuota> {
    const user = await User.findById(userId);
    return {
      dailyLimit: DOC_QUOTA.dailyGenerations,
      usedToday: await this.generationsToday(userId),
      canProposePullRequests: canWrite(user?.tokenScopes ?? [], false),
    };
  }

  async generate(input: GenerateInput): Promise<{ doc: DocDoc; reused: boolean }> {
    const run = await this.run(`${input.owner}/${input.name}`, input.userId);
    const key = { fullName: run.fullName, sha: run.sha, kind: input.kind, createdBy: input.userId };
    const existing = await GeneratedDoc.findOne(key);
    if (existing && !input.force) return { doc: existing, reused: true };
    if ((await this.generationsToday(input.userId)) >= DOC_QUOTA.dailyGenerations) {
      throw AppError.quotaExceeded(`You have used today's ${DOC_QUOTA.dailyGenerations} document generations`);
    }

    // Private content may only reach a model with the user's opt-in; without it, facts only.
    const allowed = await mayUseModels(run, input.userId);
    const privateContent = run.private;
    const facts = await this.facts(run, input.viewer);
    const generator =
      input.kind === 'changelog'
        ? changelogGenerator({
            github: this.options.github,
            gateway: this.options.gateway,
            ...(input.viewer && { viewer: input.viewer }),
            userId: input.userId,
            privateContent: allowed ? privateContent : null,
          })
        : STATIC[input.kind];
    const plan = await generator(facts, { ...(input.from && { from: input.from }), ...(input.to && { to: input.to }) });
    const composed = await composeDoc(this.options.gateway, facts, plan, {
      kind: input.kind,
      models: {
        allowed: allowed && this.options.gateway.available('explain', { privateContent }),
        privateContent,
        reason: !allowed
          ? 'Explanations were not written: chat and documentation for private repositories are off in Settings.'
          : 'Explanations were not written: no model provider that may receive this repository is configured.',
      },
      userId: input.userId,
    });
    const doc = await GeneratedDoc.findOneAndUpdate(
      key,
      {
        $set: {
          private: run.private,
          title: composed.title,
          targetPath: DOC_TARGETS[input.kind],
          content: composed.content,
          origin: composed.origin,
          sections: composed.sections,
          citations: composed.citations,
          droppedCitations: composed.droppedCitations,
          writtenBy: composed.model ?? undefined,
          notes: composed.notes,
          generatedAt: new Date(this.now()),
        },
        $unset: { editedAt: '' },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    return { doc, reused: false };
  } // prettier-ignore

  async list(fullName: string, userId: string): Promise<DocDoc[]> {
    return GeneratedDoc.find({ fullName: fullName.toLowerCase(), createdBy: userId })
      .sort({ generatedAt: -1 })
      .limit(100);
  }

  async get(id: string, userId: string): Promise<DocDoc> {
    const doc = isObjectId(id) ? await GeneratedDoc.findById(id) : null;
    // Someone else's document looks exactly like a missing one.
    if (!doc?.createdBy.equals(userId)) throw AppError.notFound('Document not found');
    return doc;
  }

  async update(id: string, userId: string, content: string, title?: string): Promise<DocDoc> {
    const doc = await this.get(id, userId);
    doc.content = content;
    if (title) doc.title = title;
    doc.origin = 'edited';
    doc.editedAt = new Date(this.now());
    doc.set('citations', uniqueCitations(content));
    await doc.save();
    return doc;
  }

  async remove(id: string, userId: string): Promise<void> {
    await (await this.get(id, userId)).deleteOne();
  }

  render(doc: DocDoc, format: 'markdown' | 'html', links: 'github' | 'relative'): { body: string; type: string; filename: string } {
    const mode: LinkMode = links === 'github' ? { mode: 'github', fullName: doc.fullName, sha: doc.sha } : { mode: 'relative', from: doc.targetPath };
    const markdown = linkCitations(doc.content, mode);
    const base = doc.targetPath.split('/').pop()?.replace(/\.md$/i, '') ?? doc.kind;
    return format === 'html'
      ? { body: toHtml(markdown, doc.title), type: 'text/html; charset=utf-8', filename: `${base}.html` }
      : { body: markdown, type: 'text/markdown; charset=utf-8', filename: `${base}.md` };
  } // prettier-ignore

  async review(id: string, userId: string, viewer?: Viewer): Promise<DocReview> {
    const doc = await this.get(id, userId);
    const run = await latestReadableRun(doc.fullName, userId, doc.sha);
    if (!run) throw AppError.notFound('The ingestion this document came from no longer exists');
    const facts = await this.facts(run, viewer);
    const allowed = await mayUseModels(run, userId);
    return reviewDoc(
      this.options.gateway,
      { id: doc.id, content: doc.content, fullName: doc.fullName },
      {
        paths: new Set(facts.paths),
        scripts: new Set(facts.data.manifests.flatMap((m) => Object.keys(m.scripts))),
      },
      {
        allowed:
          allowed && this.options.gateway.available('structured', { privateContent: run.private }),
        privateContent: run.private,
        userId,
      },
    );
  }

  async drift(id: string, userId: string, viewer?: Viewer): Promise<DocDrift> {
    const doc = await this.get(id, userId);
    const latest = await latestReadableRun(doc.fullName, userId);
    return detectDrift(
      this.options.github,
      {
        id: doc.id,
        fullName: doc.fullName,
        sha: doc.sha,
        sections: doc.sections.map((s) => ({
          id: s.id,
          heading: s.heading,
          missing: s.missing ?? null,
          citations: s.citations.map((c) => ({
            path: c.path,
            startLine: c.startLine,
            endLine: c.endLine,
          })),
        })),
        citations: doc.citations.map((c) => ({
          path: c.path,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
      },
      latest?.sha ?? null,
      viewer,
    );
  }

  async missing(
    fullName: string,
    userId: string | undefined,
    viewer?: Viewer,
  ): Promise<MissingDocs> {
    const run = await this.run(fullName, userId);
    return findMissingDocs(await this.facts(run, viewer));
  }

  /**
   * Opens a draft pull request with the chosen documents. Runs only on an explicit request
   * whose confirmed paths match the documents exactly.
   */
  async propose(
    input: { docIds: string[]; confirmPaths: string[]; title?: string },
    userId: string,
    viewer: Viewer | undefined,
  ): Promise<InstanceType<typeof DocPullRequest>> {
    if (!viewer) throw AppError.unauthorized('Sign in again so your GitHub token can be used');
    const docs = await Promise.all([...new Set(input.docIds)].map((id) => this.get(id, userId)));
    const first = docs[0];
    if (!first) throw AppError.badRequest('Choose at least one document');
    if (docs.some((d) => d.fullName !== first.fullName)) throw AppError.badRequest('All documents must belong to one repository');
    const paths = docs.map((d) => d.targetPath).sort();
    const confirmed = [...new Set(input.confirmPaths)].sort();
    if (paths.length !== new Set(paths).size) throw AppError.badRequest('Two documents would write the same file');
    if (paths.join('\n') !== confirmed.join('\n')) {
      throw AppError.badRequest('The confirmed files do not match the documents; review the list and confirm again', { expected: paths });
    }
    const user = await User.findById(userId);
    if (!canWrite(user?.tokenScopes ?? [], first.private)) {
      throw new AppError(403, 'DOCS_WRITE_SCOPE', 'Allow documentation pull requests in Settings first; GitHub will ask you to grant write access');
    }
    const [owner = '', name = ''] = first.fullName.split('/');
    const title = input.title ?? `docs: ${docs.length === 1 ? `add ${DOC_LABELS[first.kind as DocKind].toLowerCase()}` : `add ${docs.length} generated documents`}`;
    const body = [
      'Documentation generated from the repository files and reviewed before opening this pull request.',
      '',
      ...docs.map((d) => `- \`${d.targetPath}\`: ${DOC_LABELS[d.kind as DocKind]} (from ${d.sha.slice(0, 7)}${d.origin === 'edited' ? ', edited' : ''})`),
      '',
      'Each citation links to the file and lines it was drawn from. Please check the text before merging.',
    ].join('\n');
    const proposed = await this.writer.propose({
      owner,
      name,
      token: viewer.token,
      files: docs.map((d) => ({ path: d.targetPath, content: this.render(d, 'markdown', 'relative').body })),
      branch: `repointelligence/docs-${first.sha.slice(0, 7)}`,
      title,
      body,
    });
    return DocPullRequest.create({
      fullName: first.fullName,
      createdBy: userId,
      docs: docs.map((d) => d._id),
      files: paths,
      branch: proposed.branch,
      base: proposed.base,
      baseSha: proposed.baseSha,
      number: proposed.number,
      url: proposed.url,
      draft: proposed.draft,
    });
  } // prettier-ignore
}

export function toDocView(doc: DocDoc): GeneratedDocView {
  return {
    id: doc.id,
    fullName: doc.fullName,
    sha: doc.sha,
    kind: doc.kind as DocKind,
    title: doc.title,
    targetPath: doc.targetPath,
    content: doc.content,
    origin: doc.origin,
    sections: doc.sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      missing: s.missing ?? null,
      citations: s.citations.map((c) => ({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    })),
    citations: doc.citations.map((c) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
    })),
    droppedCitations: doc.droppedCitations,
    model: doc.writtenBy ?? null,
    notes: doc.notes,
    generatedAt: doc.generatedAt.toISOString(),
    editedAt: doc.editedAt?.toISOString() ?? null,
  };
}

export function toPullRequestView(pr: InstanceType<typeof DocPullRequest>): DocPullRequestView {
  return {
    id: pr.id,
    fullName: pr.fullName,
    branch: pr.branch,
    base: pr.base,
    number: pr.number,
    url: pr.url,
    draft: pr.draft,
    files: pr.files,
    createdAt: pr.createdAt.toISOString(),
  };
}
