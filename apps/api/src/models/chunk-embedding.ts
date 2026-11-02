import { Schema, model, type InferSchemaType } from 'mongoose';

// One vector per ingestion chunk. The text stays in the Artifact row; this joins on chunkId.
const chunkEmbeddingSchema = new Schema(
  {
    fullName: { type: String, required: true, lowercase: true },
    sha: { type: String, required: true },
    chunkId: { type: String, required: true },
    path: { type: String, required: true },
    model: { type: String, required: true },
    vector: { type: [Number], required: true },
  },
  { minimize: false },
);

chunkEmbeddingSchema.index({ fullName: 1, sha: 1, chunkId: 1 }, { unique: true });

export type ChunkEmbeddingDoc = InferSchemaType<typeof chunkEmbeddingSchema>;
export const ChunkEmbedding = model('ChunkEmbedding', chunkEmbeddingSchema);

/**
 * Atlas Vector Search index for the `chunkembeddings` collection. Create it in the Atlas UI
 * (Search > Create Index > JSON editor) with this definition, then set VECTOR_SEARCH_ENABLED.
 */
export const VECTOR_INDEX_NAME = 'chunk_vectors';
export const VECTOR_INDEX_DEFINITION = {
  fields: [
    { type: 'vector', path: 'vector', numDimensions: 384, similarity: 'cosine' },
    { type: 'filter', path: 'fullName' },
    { type: 'filter', path: 'sha' },
  ],
} as const;
