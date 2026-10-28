import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

/** Encrypts with AES-256-GCM. Output is `v1:iv:tag:ciphertext`, each part base64. */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
}

export function decryptToken(payload: string, key: Buffer): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error('Unsupported token format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
