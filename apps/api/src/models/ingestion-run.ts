import { Schema, model, type InferSchemaType } from 'mongoose';

export const INGESTION_STATUSES = ['running', 'completed', 'partial', 'failed'] as const;
export const EMBEDDING_STATUSES = ['none', 'queued', 'running', 'ready', 'failed'] as const;

// Progress of the vector index built from this run's chunks, for repository chat.
const embeddingSchema = new Schema(
  {
    status: { type: String, enum: EMBEDDING_STATUSES, required: true, default: 'none' },
    embedded: { type: Number, required: true, default: 0 },
    model: { type: String },
    error: { type: String },
    updatedAt: { type: Date },
  },
  { _id: false },
);

// One row per repository and commit, so ingesting the same commit twice is a lookup.
const ingestionRunSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    ref: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Private runs are only readable by the user who started them.
    private: { type: Boolean, required: true, default: false },
    status: { type: String, enum: INGESTION_STATUSES, required: true, default: 'running' },
    stats: { type: Schema.Types.Mixed },
    error: { type: String },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    embedding: { type: embeddingSchema, default: () => ({}) },
  },
  { timestamps: true, minimize: false },
);

ingestionRunSchema.index({ fullName: 1, sha: 1 }, { unique: true });
ingestionRunSchema.index({ fullName: 1, completedAt: -1 });

export type IngestionRunDoc = InferSchemaType<typeof ingestionRunSchema>;
export const IngestionRun = model('IngestionRun', ingestionRunSchema);
