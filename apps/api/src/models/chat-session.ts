import { Schema, model, type InferSchemaType } from 'mongoose';

const citationSchema = new Schema(
  {
    path: { type: String, required: true },
    startLine: { type: Number, min: 1 },
    endLine: { type: Number, min: 1 },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    citations: { type: [citationSchema], default: [] },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const chatSessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    repository: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
    title: { type: String },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

export type ChatSessionDoc = InferSchemaType<typeof chatSessionSchema>;
export const ChatSession = model('ChatSession', chatSessionSchema);
