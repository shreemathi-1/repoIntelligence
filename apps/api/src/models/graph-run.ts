import { Schema, model, type InferSchemaType } from 'mongoose';
import { ANALYSIS_STATUSES } from './analysis-run.js';

const progressSchema = new Schema(
  {
    step: { type: String, required: true, default: 'queued' },
    percent: { type: Number, required: true, default: 0 },
    message: { type: String, required: true, default: 'Waiting in the queue' },
  },
  { _id: false },
);

// One graph build per request; finished builds for a commit are reused.
const graphRunSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ref: { type: String },
    sha: { type: String },
    treeDigest: { type: String },
    status: { type: String, enum: ANALYSIS_STATUSES, default: 'queued', required: true },
    progress: { type: progressSchema, default: () => ({}) },
    attempt: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    error: { type: String },
    queuedAt: { type: Date, required: true, default: () => new Date() },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);

graphRunSchema.index({ fullName: 1, sha: 1, status: 1 });

export type GraphRunDoc = InferSchemaType<typeof graphRunSchema>;
export const GraphRun = model('GraphRun', graphRunSchema);
