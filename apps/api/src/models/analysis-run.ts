import { Schema, model, type InferSchemaType } from 'mongoose';

export const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

const analysisRunSchema = new Schema(
  {
    repository: { type: Schema.Types.ObjectId, ref: 'Repository', required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ANALYSIS_STATUSES, default: 'queued', required: true },
    commitSha: { type: String },
    // Scanner output keyed by metric name. A metric that was not measured is simply absent.
    metrics: { type: Schema.Types.Mixed },
    error: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

analysisRunSchema.index({ repository: 1, createdAt: -1 });

export type AnalysisRunDoc = InferSchemaType<typeof analysisRunSchema>;
export const AnalysisRun = model('AnalysisRun', analysisRunSchema);
