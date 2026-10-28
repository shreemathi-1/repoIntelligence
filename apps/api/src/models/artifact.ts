import { Schema, model, type InferSchemaType } from 'mongoose';

export const ARTIFACT_KINDS = [
  'document',
  'openapi',
  'manifest',
  'env',
  'symbols',
  'chunk',
  'findings',
  'meta',
] as const;

// Every artifact carries the commit it was derived from.
const artifactSchema = new Schema({
  run: { type: Schema.Types.ObjectId, ref: 'IngestionRun', required: true },
  fullName: { type: String, required: true, lowercase: true },
  sha: { type: String, required: true },
  kind: { type: String, enum: ARTIFACT_KINDS, required: true },
  path: { type: String, default: '' },
  order: { type: Number, required: true },
  data: { type: Schema.Types.Mixed, required: true },
});

artifactSchema.index({ run: 1, kind: 1, order: 1 });

export type ArtifactDoc = InferSchemaType<typeof artifactSchema>;
export const Artifact = model('Artifact', artifactSchema);
