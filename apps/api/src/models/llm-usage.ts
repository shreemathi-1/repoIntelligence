import { Schema, model, type InferSchemaType } from 'mongoose';

// One row per model call, successful or not, so budgets and failures can be inspected.
const llmUsageSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    fullName: { type: String, lowercase: true },
    task: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    estimated: { type: Boolean, required: true, default: false },
    costUsd: { type: Number, required: true, default: 0 },
    latencyMs: { type: Number, required: true },
    ok: { type: Boolean, required: true },
    // Error kind only, never the prompt or the provider's full message.
    error: { type: String },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { minimize: false },
);

llmUsageSchema.index({ user: 1, createdAt: -1 });
llmUsageSchema.index({ provider: 1, createdAt: -1 });

export type LlmUsageDoc = InferSchemaType<typeof llmUsageSchema>;
export const LlmUsage = model('LlmUsage', llmUsageSchema);
