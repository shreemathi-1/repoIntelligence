import { Schema, model, type InferSchemaType } from 'mongoose';

// The worker's graph for one commit. Identical file trees share the same digest, so a new
// commit that changed nothing structural is served from the previous graph.
const architectureGraphSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    treeDigest: { type: String, index: true },
    graph: { type: Schema.Types.Mixed, required: true },
    computedAt: { type: Date, required: true },
  },
  { minimize: false },
);

architectureGraphSchema.index({ fullName: 1, sha: 1 }, { unique: true });
architectureGraphSchema.index({ fullName: 1, computedAt: -1 });

export type ArchitectureGraphDoc = InferSchemaType<typeof architectureGraphSchema>;
export const ArchitectureGraphModel = model('ArchitectureGraph', architectureGraphSchema);
