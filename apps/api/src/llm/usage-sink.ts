import { LlmUsage } from '../models/llm-usage.js';
import type { UsageRecord, UsageSink } from './gateway.js';

/** Writes each model call to the database. */
export class MongoUsageSink implements UsageSink {
  async record(entry: UsageRecord): Promise<void> {
    const { userId, fullName, ...rest } = entry;
    await LlmUsage.create({
      ...rest,
      ...(userId && { user: userId }),
      ...(fullName && { fullName }),
    });
  }
}

export interface UsageTotals {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byProvider: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

/** A user's totals since midnight UTC. */
export async function usageToday(userId: string, now = Date.now()): Promise<UsageTotals> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await LlmUsage.find({ user: userId, createdAt: { $gte: dayStart } }).lean();
  const totals: UsageTotals = {
    calls: rows.length,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    byProvider: {},
  };
  for (const row of rows) {
    if (!row.ok) totals.failed += 1;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd += row.costUsd;
    const p = (totals.byProvider[row.provider] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    p.calls += 1;
    p.inputTokens += row.inputTokens;
    p.outputTokens += row.outputTokens;
  }
  return totals;
}
