import { Schema, model, type InferSchemaType } from 'mongoose';

// A user's own stack, as answered in the adaptability questionnaire.
const stackProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    // The validated questionnaire answers.
    answers: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, minimize: false },
);

export type StackProfileDoc = InferSchemaType<typeof stackProfileSchema>;
export const StackProfile = model('StackProfile', stackProfileSchema);
