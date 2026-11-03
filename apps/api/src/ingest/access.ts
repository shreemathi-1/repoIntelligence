import mongoose from 'mongoose';
import { AppError } from '../errors.js';
import { IngestionRun } from '../models/ingestion-run.js';
import { User } from '../models/user.js';

const READY = ['completed', 'partial'] as const;

export const isObjectId = (id: string | undefined): id is string =>
  id !== undefined && mongoose.isValidObjectId(id);

/** The newest finished ingestion the caller may read; private runs belong to their owner. */
export async function latestReadableRun(
  fullName: string,
  userId?: string,
  sha?: string,
): Promise<InstanceType<typeof IngestionRun> | null> {
  const query = IngestionRun.findOne({
    fullName: fullName.toLowerCase(),
    status: { $in: [...READY] },
  });
  if (sha) query.where({ sha: sha.toLowerCase() });
  if (isObjectId(userId)) query.or([{ private: false }, { requestedBy: userId }]);
  else query.where({ private: false });
  return query.sort({ completedAt: -1 });
}

/** Whether a private run's content may go to model providers; public runs always may. */
export async function mayUseModels(
  run: InstanceType<typeof IngestionRun>,
  userId: string,
): Promise<boolean> {
  if (!run.private) return true;
  const user = await User.findById(userId);
  return user?.preferences.allowPrivateRepoLlm === true;
}

/**
 * Throws when private content may not be sent; returns whether the content is private, which
 * restricts routing to providers that do not train on inputs.
 */
export async function requireModelConsent(
  run: InstanceType<typeof IngestionRun>,
  userId: string,
): Promise<boolean> {
  if (!run.private) return false;
  if (await mayUseModels(run, userId)) return true;
  throw new AppError(
    403,
    'PRIVATE_LLM_OPT_IN',
    'Chat about private repositories is off. Turn it on in Settings to send this repository to model providers that do not train on inputs.',
  );
}
