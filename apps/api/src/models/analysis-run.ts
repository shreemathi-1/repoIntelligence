import { Schema, model, type InferSchemaType } from 'mongoose';

export const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ANALYSIS_STEPS = [
  'queued',
  'fetching',
  'scanning',
  'collecting',
  'scoring',
  'done',
] as const;

const progressSchema = new Schema(
  {
    step: { type: String, enum: ANALYSIS_STEPS, required: true, default: 'queued' },
    percent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    message: { type: String, required: true, default: 'Waiting in the queue' },
  },
  { _id: false },
);

// One run per request. Finished runs are reused when the same commit is asked for again.
const analysisRunSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    repository: { type: Schema.Types.ObjectId, ref: 'Repository' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ref: { type: String },
    sha: { type: String },
    // Hash of every file path and blob id, so an identical tree can reuse its scan.
    treeDigest: { type: String },
    status: { type: String, enum: ANALYSIS_STATUSES, default: 'queued', required: true },
    progress: { type: progressSchema, default: () => ({}) },
    attempt: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    // What the formula read and what it produced. Kept so history and the simulator work offline.
    inputs: { type: Schema.Types.Mixed },
    score: { type: Schema.Types.Mixed },
    error: { type: String },
    queuedAt: { type: Date, required: true, default: () => new Date() },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);

analysisRunSchema.index({ fullName: 1, sha: 1, status: 1 });
analysisRunSchema.index({ fullName: 1, finishedAt: -1 });
analysisRunSchema.index({ requestedBy: 1, queuedAt: -1 });

export type AnalysisRunDoc = InferSchemaType<typeof analysisRunSchema>;
export const AnalysisRun = model('AnalysisRun', analysisRunSchema);
