import { Schema, model, type InferSchemaType } from 'mongoose';

// Which onboarding steps a user has ticked for a repository. Step ids are stable across commits.
const onboardingProgressSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fullName: { type: String, required: true, lowercase: true },
    done: { type: [String], default: [] },
  },
  { timestamps: true },
);

onboardingProgressSchema.index({ user: 1, fullName: 1 }, { unique: true });

export type OnboardingProgressDoc = InferSchemaType<typeof onboardingProgressSchema>;
export const OnboardingProgress = model('OnboardingProgress', onboardingProgressSchema);
