import { z } from 'zod';
import { issueSchema } from './discovery.js';
import { LAYERS } from './graph.js';

/** A place in the repository at the ingested commit. */
export const fileRefSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
});
export type FileRef = z.infer<typeof fileRefSchema>;

const hours = z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() });
const checkItem = z.object({ id: z.string(), text: z.string(), done: z.boolean() });
export const progressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const progressUpdateSchema = z
  .object({ done: z.array(z.string().max(120)).max(300) })
  .strict();

// ---- onboarding ------------------------------------------------------------------------------------

export const LEARNING_MODES = ['beginner', 'advanced'] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const onboardingQuerySchema = z.object({
  mode: z.enum(LEARNING_MODES).default('beginner'),
});

export const COMPLEXITY = ['small', 'medium', 'large'] as const;

export const onboardingSchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  mode: z.enum(LEARNING_MODES),
  notes: z.array(z.string()),
  walkthrough: z.object({
    // Sentences assembled from detected facts; nothing here is written by a model.
    summary: z.array(z.string()),
    layout: z.array(z.object({ path: z.string(), files: z.number().int(), role: z.string() })),
    entryPoints: z.array(fileRefSchema.extend({ label: z.string() })),
    flows: z.array(fileRefSchema.extend({ title: z.string(), handler: z.string().nullable() })),
  }),
  prerequisites: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['runtime', 'tool', 'service', 'knowledge']),
      label: z.string(),
      detail: z.string(),
      source: fileRefSchema.nullable(),
    }),
  ),
  install: z.array(
    z.object({
      id: z.string(),
      command: z.string(),
      why: z.string(),
      source: fileRefSchema.nullable(),
    }),
  ),
  troubleshooting: z.array(
    z.object({
      id: z.string(),
      symptom: z.string(),
      fix: z.string(),
      source: fileRefSchema.nullable(),
    }),
  ),
  readingList: z.array(fileRefSchema.extend({ reason: z.string() })),
  roadmap: z.object({
    complexity: z.enum(COMPLEXITY),
    // What the size was judged from, e.g. "184 source files, 12 modules".
    basis: z.string(),
    stages: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        goal: z.string(),
        files: z.array(z.string()),
      }),
    ),
  }),
  checklist: z.array(checkItem),
  progress: progressSchema,
});
export type Onboarding = z.infer<typeof onboardingSchema>;

export const STARTER_KINDS = ['missing-tests', 'undocumented', 'todo', 'docs'] as const;
export const starterIssuesSchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  // Open issues the maintainers labelled "good first issue".
  github: z.array(issueSchema),
  // Small, self-contained gaps found in the ingested files.
  candidates: z.array(
    fileRefSchema.extend({
      id: z.string(),
      kind: z.enum(STARTER_KINDS),
      title: z.string(),
      detail: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});
export type StarterIssues = z.infer<typeof starterIssuesSchema>;

// ---- feature plans ---------------------------------------------------------------------------------

export const MAX_PLAN_TASKS = 12;
export const MAX_PLAN_FILES = 25;
export const MAX_PLANS_PER_REPO = 20;

export const planRequestSchema = z.object({ goal: z.string().trim().min(10).max(1000) }).strict();
export type PlanRequest = z.infer<typeof planRequestSchema>;

export const RISK = ['low', 'medium', 'high'] as const;

export const planFileSchema = z.object({
  // A path that exists at the commit, or a new file inside a directory that exists.
  path: z.string(),
  change: z.enum(['modify', 'create']),
  module: z.string(),
  layer: z.enum(LAYERS).nullable(),
  lines: z.number().int().nonnegative().nullable(),
  importedBy: z.number().int().nonnegative().nullable(),
  // Why this file is part of the task; null when no model wrote the plan.
  reason: z.string().nullable(),
});
export type PlanFile = z.infer<typeof planFileSchema>;

export const planTaskSchema = z.object({
  id: z.string(),
  order: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  files: z.array(planFileSchema).min(1),
  // Tasks whose files this task's files import; they come first.
  dependsOn: z.array(z.string()),
  api: z.array(
    fileRefSchema
      .partial()
      .extend({ method: z.string(), route: z.string(), change: z.enum(['existing', 'new']) }),
  ),
  database: z.array(
    z.object({
      model: z.string(),
      change: z.enum(['existing', 'new']),
      path: z.string().nullable(),
    }),
  ),
  tests: z.array(z.object({ path: z.string(), exists: z.boolean(), note: z.string() })),
  risk: z.object({ level: z.enum(RISK), reasons: z.array(z.string()) }),
  effort: hours,
  done: z.boolean(),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const implementationPlanSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  sha: z.string(),
  goal: z.string(),
  generatedAt: z.string(),
  // `model`: a model proposed the tasks and the server checked them. `files-only`: no model ran.
  origin: z.enum(['model', 'files-only']),
  writtenBy: z.string().nullable(),
  notes: z.array(z.string()),
  // What the checks removed from the proposal because it did not match the repository.
  dropped: z.object({ tasks: z.number().int(), files: z.number().int() }),
  relevantFiles: z.array(fileRefSchema.extend({ why: z.string() })),
  tasks: z.array(planTaskSchema),
  totals: z.object({ effort: hours, risk: z.enum(RISK), files: z.number().int() }),
  progress: progressSchema,
});
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

export const planListSchema = z.object({
  plans: z.array(
    z.object({
      id: z.string(),
      goal: z.string(),
      sha: z.string(),
      generatedAt: z.string(),
      origin: z.enum(['model', 'files-only']),
      progress: progressSchema,
    }),
  ),
  limit: z.number().int(),
});
export type PlanList = z.infer<typeof planListSchema>;

export const planExportQuerySchema = z.object({
  format: z.enum(['markdown', 'issue']).default('markdown'),
});
