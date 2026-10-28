import { Schema, model, type InferSchemaType } from 'mongoose';

const collectionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    repositories: [{ type: Schema.Types.ObjectId, ref: 'Repository' }],
  },
  { timestamps: true },
);

collectionSchema.index({ user: 1, name: 1 }, { unique: true });

export type CollectionDoc = InferSchemaType<typeof collectionSchema>;
export const Collection = model('Collection', collectionSchema);
