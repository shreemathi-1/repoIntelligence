import { Schema, model, type InferSchemaType } from 'mongoose';

// Scanner output for one exact file tree. Two commits with identical files share an entry.
const scanCacheSchema = new Schema(
  {
    treeDigest: { type: String, required: true, unique: true },
    fullName: { type: String, required: true },
    sha: { type: String, required: true },
    scan: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true, index: { expireAfterSeconds: 30 * 24 * 60 * 60 } },
  },
  { minimize: false },
);

export type ScanCacheDoc = InferSchemaType<typeof scanCacheSchema>;
export const ScanCache = model('ScanCache', scanCacheSchema);
