import { Schema, model, type InferSchemaType } from 'mongoose';

export const JOB_STATUSES = ['pending', 'active', 'completed', 'failed'] as const;

const jobRecordSchema = new Schema(
  {
    type: { type: String, required: true, index: true },
    status: { type: String, enum: JOB_STATUSES, default: 'pending', required: true },
    payload: { type: Schema.Types.Mixed },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String },
    runAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

jobRecordSchema.index({ status: 1, runAt: 1 });

export type JobRecordDoc = InferSchemaType<typeof jobRecordSchema>;
export const JobRecord = model('JobRecord', jobRecordSchema);
