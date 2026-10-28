import { Schema, model, type InferSchemaType } from 'mongoose';

const searchHistorySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['search', 'viewed'], required: true },
  query: { type: String, default: '' },
  fullName: { type: String, default: '' },
  filters: { type: Schema.Types.Mixed },
  at: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

searchHistorySchema.index({ user: 1, at: -1 });
searchHistorySchema.index({ user: 1, kind: 1, query: 1, fullName: 1 }, { unique: true });

export type SearchHistoryDoc = InferSchemaType<typeof searchHistorySchema>;
export const SearchHistory = model('SearchHistory', searchHistorySchema);
