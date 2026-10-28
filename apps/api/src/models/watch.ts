import { Schema, model, type InferSchemaType } from 'mongoose';

// Everything under lastSeen stays unset until the user has looked once, so a first check
// reports "nothing to compare with" instead of a made-up change.
const watchSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    repository: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
    lastSeen: {
      checkedAt: { type: Date },
      releaseTag: { type: String },
      commitSha: { type: String },
      openIssues: { type: Number },
    },
  },
  { timestamps: true },
);

watchSchema.index({ user: 1, repository: 1 }, { unique: true });

export type WatchDoc = InferSchemaType<typeof watchSchema>;
export const Watch = model('Watch', watchSchema);
