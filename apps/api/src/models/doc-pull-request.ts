import { Schema, model, type InferSchemaType } from 'mongoose';

// A record of every documentation pull request opened on a user's behalf.
const docPullRequestSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    docs: { type: [Schema.Types.ObjectId], ref: 'GeneratedDoc', default: [] },
    files: { type: [String], default: [] },
    branch: { type: String, required: true },
    base: { type: String, required: true },
    baseSha: { type: String, required: true },
    number: { type: Number, required: true },
    url: { type: String, required: true },
    draft: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export type DocPullRequestDoc = InferSchemaType<typeof docPullRequestSchema>;
export const DocPullRequest = model('DocPullRequest', docPullRequestSchema);
