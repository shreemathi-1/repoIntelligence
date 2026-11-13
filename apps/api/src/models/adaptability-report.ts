import { Schema, model, type InferSchemaType } from 'mongoose';

// One report per repository commit, user and stack. Rule-based facts and the model's explanation
// are stored in separate fields.
const adaptabilityReportSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    private: { type: Boolean, required: true, default: false },
    profile: { type: Schema.Types.Mixed, required: true },
    profileHash: { type: String, required: true },
    facts: { type: Schema.Types.Mixed, required: true },
    notes: { type: [String], default: [] },
    // Ids of the checklist items the user has ticked.
    done: { type: [String], default: [] },
    interpretation: { type: Schema.Types.Mixed, default: null },
    interpretationNote: { type: String, default: null },
    // Set when a model wrote the explanation, which counts toward the daily generation quota.
    explainedAt: { type: Date },
    generatedAt: { type: Date, required: true },
  },
  { minimize: false },
);

adaptabilityReportSchema.index(
  { fullName: 1, sha: 1, createdBy: 1, profileHash: 1 },
  { unique: true },
);
adaptabilityReportSchema.index({ createdBy: 1, explainedAt: -1 });

export type AdaptabilityReportDoc = InferSchemaType<typeof adaptabilityReportSchema>;
export const AdaptabilityReport = model('AdaptabilityReport', adaptabilityReportSchema);
