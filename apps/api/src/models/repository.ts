import { Schema, model, type InferSchemaType } from 'mongoose';

// Optional fields stay unset when GitHub did not give us a value; unset means unavailable, not 0.
const repositorySchema = new Schema(
  {
    owner: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    fullName: { type: String, required: true, unique: true, lowercase: true },
    githubId: { type: Number, index: true, sparse: true },
    description: { type: String },
    defaultBranch: { type: String },
    primaryLanguage: { type: String },
    stars: { type: Number, min: 0 },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

export type RepositoryDoc = InferSchemaType<typeof repositorySchema>;
export const Repository = model('Repository', repositorySchema);
