import { Schema, model, type InferSchemaType } from 'mongoose';

const citationSchema = new Schema(
  {
    path: { type: String, required: true },
    startLine: { type: Number, min: 1, required: true },
    endLine: { type: Number, min: 1, required: true },
  },
  { _id: false },
);

const sectionSchema = new Schema(
  {
    id: { type: String, required: true },
    heading: { type: String, required: true },
    missing: { type: String },
    citations: { type: [citationSchema], default: [] },
  },
  { _id: false },
);

// One generated document per repository, commit and kind; user edits replace the content in place.
const generatedDocSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    kind: { type: String, required: true },
    // Private documents are only visible to the user who generated them.
    private: { type: Boolean, required: true, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    targetPath: { type: String, required: true },
    content: { type: String, required: true },
    origin: { type: String, enum: ['facts', 'prose', 'edited'], required: true },
    sections: { type: [sectionSchema], default: [] },
    citations: { type: [citationSchema], default: [] },
    droppedCitations: { type: Number, required: true, default: 0 },
    // "provider/model". Not called `model`: documents have a method by that name.
    writtenBy: { type: String },
    notes: { type: [String], default: [] },
    generatedAt: { type: Date, required: true },
    editedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);

generatedDocSchema.index({ fullName: 1, sha: 1, kind: 1, createdBy: 1 }, { unique: true });
generatedDocSchema.index({ createdBy: 1, generatedAt: -1 });

export type GeneratedDocDoc = InferSchemaType<typeof generatedDocSchema>;
export const GeneratedDoc = model('GeneratedDoc', generatedDocSchema);
