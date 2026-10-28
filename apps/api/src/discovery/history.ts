import type { Types } from 'mongoose';
import { SearchHistory } from '../models/search-history.js';

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

interface Entry {
  kind: 'search' | 'viewed';
  query?: string;
  fullName?: string;
  filters?: unknown;
}

/** Records one history line. Repeating the same search or view just bumps its timestamp. */
export async function recordHistory(
  userId: string | Types.ObjectId,
  entry: Entry,
  now: number = Date.now(),
): Promise<void> {
  const query = entry.query ?? '';
  const fullName = (entry.fullName ?? '').toLowerCase();
  await SearchHistory.updateOne(
    { user: userId, kind: entry.kind, query, fullName },
    {
      $set: {
        filters: entry.filters,
        at: new Date(now),
        expiresAt: new Date(now + KEEP_MS),
      },
    },
    { upsert: true },
  );
}
