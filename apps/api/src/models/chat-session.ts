import { Schema, model, type InferSchemaType } from 'mongoose';

const citationSchema = new Schema(
  {
    path: { type: String, required: true },
    startLine: { type: Number, min: 1, required: true },
    endLine: { type: Number, min: 1, required: true },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    citations: { type: [citationSchema], default: [] },
    confidence: { type: String, enum: ['verified', 'inferred', 'insufficient'] },
    // "provider/model" that wrote an assistant message. Not called `model`: subdocuments have a method by that name.
    answeredBy: { type: String },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

// A session is pinned to one commit, so every citation in it refers to the same files.
const chatSessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    title: { type: String },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

chatSessionSchema.index({ user: 1, fullName: 1, updatedAt: -1 });

export type ChatSessionDoc = InferSchemaType<typeof chatSessionSchema>;
export const ChatSession = model('ChatSession', chatSessionSchema);
