import { Schema, model, type InferSchemaType } from 'mongoose';

// A feature plan for one commit. Tasks are stored after they were checked against the repository.
const implementationPlanSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    private: { type: Boolean, required: true, default: false },
    goal: { type: String, required: true },
    // `model` when a model proposed the tasks, `files-only` when none ran.
    origin: { type: String, enum: ['model', 'files-only'], required: true },
    writtenBy: { type: String, default: null },
    notes: { type: [String], default: [] },
    dropped: { type: Schema.Types.Mixed, required: true },
    relevantFiles: { type: Schema.Types.Mixed, required: true },
    tasks: { type: Schema.Types.Mixed, required: true },
    // Ids of the tasks the user has ticked.
    done: { type: [String], default: [] },
    generatedAt: { type: Date, required: true },
  },
  { minimize: false },
);

implementationPlanSchema.index({ createdBy: 1, fullName: 1, generatedAt: -1 });

export type ImplementationPlanDoc = InferSchemaType<typeof implementationPlanSchema>;
export const ImplementationPlan = model('ImplementationPlan', implementationPlanSchema);
