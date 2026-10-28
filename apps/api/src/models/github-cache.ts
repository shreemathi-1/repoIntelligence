import { Schema, model, type InferSchemaType } from 'mongoose';

const githubCacheSchema = new Schema({
  // `<scope>|<request>` where scope is `public` or `user:<id>`.
  key: { type: String, required: true, unique: true },
  etag: { type: String },
  body: { type: Schema.Types.Mixed, required: true },
  fetchedAt: { type: Date, required: true },
  // After this moment the entry is revalidated with its ETag.
  staleAt: { type: Date },
  // Hard expiry. Immutable, SHA-addressed data leaves this unset and never expires.
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
});

export type GithubCacheDoc = InferSchemaType<typeof githubCacheSchema>;
export const GithubCache = model('GithubCache', githubCacheSchema);
