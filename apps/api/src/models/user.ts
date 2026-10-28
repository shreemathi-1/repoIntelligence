import { Schema, model, type InferSchemaType } from 'mongoose';

const preferencesSchema = new Schema(
  {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    defaultLanguage: { type: String, maxlength: 50 },
    privateRepoAccess: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    githubId: { type: Number, required: true, unique: true },
    login: { type: String, required: true, trim: true },
    avatarUrl: { type: String },
    email: { type: String, lowercase: true, trim: true },
    // AES-GCM payload from auth/token-crypto. Never selected by default and never returned.
    encryptedAccessToken: { type: String, select: false },
    tokenScopes: { type: [String], default: [] },
    preferences: { type: preferencesSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
