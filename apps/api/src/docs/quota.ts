import { GeneratedDoc } from '../models/generated-doc.js';
import { ReleaseSummary } from '../models/release-summary.js';

/** Document generations and release summaries share one daily allowance per user. */
export const DOC_QUOTA = { dailyGenerations: 10 } as const;

export async function generationsToday(userId: string, now: number): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [docs, summaries] = await Promise.all([
    GeneratedDoc.countDocuments({ createdBy: userId, generatedAt: { $gte: dayStart } }),
    ReleaseSummary.countDocuments({
      createdBy: userId,
      charged: true,
      generatedAt: { $gte: dayStart },
    }),
  ]);
  return docs + summaries;
}
