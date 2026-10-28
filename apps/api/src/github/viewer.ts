import { decryptToken } from '../auth/token-crypto.js';
import type { AuthConfig } from '../config.js';
import { User } from '../models/user.js';
import type { Viewer } from './service.js';

/** The signed-in user's own GitHub token, or undefined for anonymous requests. */
export async function loadViewer(
  userId: unknown,
  auth: AuthConfig | undefined,
): Promise<Viewer | undefined> {
  if (typeof userId !== 'string' || !auth) return undefined;
  const user = await User.findById(userId).select('+encryptedAccessToken');
  if (!user?.encryptedAccessToken) return undefined;
  return { userId: user.id, token: decryptToken(user.encryptedAccessToken, auth.tokenKey) };
}
