import { Schema, model, type InferSchemaType } from 'mongoose';

const trendingSnapshotSchema = new Schema({
  // `<period>|<topic id or "all">`
  key: { type: String, required: true, unique: true },
  period: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
  topic: { type: String, required: true },
  items: { type: Schema.Types.Mixed, required: true },
  computedAt: { type: Date, required: true },
});

export type TrendingSnapshotDoc = InferSchemaType<typeof trendingSnapshotSchema>;
export const TrendingSnapshot = model('TrendingSnapshot', trendingSnapshotSchema);
