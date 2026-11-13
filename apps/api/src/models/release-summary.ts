import { Schema, model, type InferSchemaType } from 'mongoose';

// A release summary keeps the retrieved facts and the model's reading of them in separate fields.
const releaseSummarySchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    tag: { type: String, required: true },
    base: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Private summaries are only served back to the user who asked for them.
    private: { type: Boolean, required: true, default: false },
    facts: { type: Schema.Types.Mixed, required: true },
    interpretation: { type: Schema.Types.Mixed, default: null },
    interpretationNote: { type: String, default: null },
    // True when a model was called, which is what counts toward the daily generation quota.
    charged: { type: Boolean, required: true, default: false },
    generatedAt: { type: Date, required: true, default: () => new Date() },
  },
  { minimize: false },
);

releaseSummarySchema.index({ fullName: 1, tag: 1, base: 1, generatedAt: -1 });
releaseSummarySchema.index({ createdBy: 1, generatedAt: -1 });

export type ReleaseSummaryDoc = InferSchemaType<typeof releaseSummarySchema>;
export const ReleaseSummary = model('ReleaseSummary', releaseSummarySchema);
