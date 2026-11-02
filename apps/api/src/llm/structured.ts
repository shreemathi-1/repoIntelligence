import type { z } from 'zod';
import { AppError } from '../errors.js';
import type { CompleteOptions, GatewayResult, LlmGateway } from './gateway.js';
import type { TaskId } from './models.config.js';
import type { ChatMessage } from './provider.js';

/** Finds the JSON in a reply that may be fenced or wrapped in prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface StructuredResult<T> {
  data: T;
  /** True when the first reply was invalid and a repair call fixed it. */
  repaired: boolean;
  result: GatewayResult;
}

/**
 * Asks for JSON, validates it, and on failure sends the reply and the validation errors back
 * once so the model can correct itself. Two invalid replies are an upstream error.
 */
export async function completeStructured<S extends z.ZodType>(
  gateway: LlmGateway,
  task: TaskId,
  messages: ChatMessage[],
  schema: S,
  options: CompleteOptions = {},
): Promise<StructuredResult<z.infer<S>>> {
  const first = await gateway.complete(task, messages, { ...options, json: true });
  const parsed = schema.safeParse(extractJson(first.text));
  if (parsed.success) return { data: parsed.data, repaired: false, result: first };

  const issues = parsed.error.issues
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .slice(0, 10)
    .join('\n');
  const repair: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: first.text.slice(0, 4000) },
    {
      role: 'user',
      content:
        'That reply was not valid for the required JSON shape. Problems:\n' +
        `${issues}\n` +
        'Reply again with only the corrected JSON object and nothing else.',
    },
  ];
  const second = await gateway.complete(task, repair, { ...options, json: true });
  const again = schema.safeParse(extractJson(second.text));
  if (again.success) return { data: again.data, repaired: true, result: second };
  throw new AppError(502, 'LLM_INVALID_OUTPUT', 'The model did not return valid structured output');
}
