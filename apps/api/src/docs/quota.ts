import { AdaptabilityReport } from '../models/adaptability-report.js';
import { GeneratedDoc } from '../models/generated-doc.js';
import { ImplementationPlan } from '../models/implementation-plan.js';
import { ReleaseSummary } from '../models/release-summary.js';

/** Everything a model writes on request shares one daily allowance per user. */
export const DOC_QUOTA = { dailyGenerations: 10 } as const;

export async function generationsToday(userId: string, now: number): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [docs, summaries, explanations, plans] = await Promise.all([
    GeneratedDoc.countDocuments({ createdBy: userId, generatedAt: { $gte: dayStart } }),
    ReleaseSummary.countDocuments({
      createdBy: userId,
      charged: true,
      generatedAt: { $gte: dayStart },
    }),
    AdaptabilityReport.countDocuments({ createdBy: userId, explainedAt: { $gte: dayStart } }),
    ImplementationPlan.countDocuments({
      createdBy: userId,
      origin: 'model',
      generatedAt: { $gte: dayStart },
    }),
  ]);
  return docs + summaries + explanations + plans;
}
