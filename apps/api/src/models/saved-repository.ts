import { Schema, model, type InferSchemaType } from 'mongoose';

const savedRepositorySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    repository: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
    note: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

savedRepositorySchema.index({ user: 1, repository: 1 }, { unique: true });

export type SavedRepositoryDoc = InferSchemaType<typeof savedRepositorySchema>;
export const SavedRepository = model('SavedRepository', savedRepositorySchema);
