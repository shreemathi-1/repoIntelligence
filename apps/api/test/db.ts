import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll } from 'vitest';

/** Starts an in-memory MongoDB for the surrounding test file and tears it down afterwards. */
export function useMemoryDb(): void {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    await mongoose.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
}
