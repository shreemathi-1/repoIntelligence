import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[\w-]{8,64}$/;

/** Reuses an incoming X-Request-Id when it looks sane, otherwise issues a new one. */
export function genRequestId(header: string | string[] | undefined): string {
  const incoming = Array.isArray(header) ? header[0] : header;
  return incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
}
