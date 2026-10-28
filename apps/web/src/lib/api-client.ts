import { errorResponseSchema, type ErrorResponse } from '@repointelligence/shared';
import type { z } from 'zod';

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, requestId }: ErrorResponse['error'] = parsed.data.error;
    return new ApiError(status, code, message, requestId);
  }
  return new ApiError(status, 'UNKNOWN_ERROR', `Request failed with status ${status}`);
}

interface RequestOptions {
  method?: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, signal } = options;
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      method,
      signal,
      // The session lives in an httpOnly cookie, so it has to be sent explicitly.
      credentials: 'include',
      ...(body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API');
  }
}

/** Calls the API and validates the JSON body against the given schema. */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.infer<S>> {
  const response = await send(path, options);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw toApiError(response.status, payload);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'The API returned an unexpected shape');
  }
  return parsed.data;
}

export function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return apiRequest(path, schema, { signal });
}

/** For endpoints that answer 204 with no body. */
export async function apiNoContent(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<void> {
  const response = await send(path, { method, body });
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => undefined));
}

export function apiPostNoContent(path: string): Promise<void> {
  return apiNoContent('POST', path);
}

/** Builds `?a=1&b=2`, leaving out empty values. */
export function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
