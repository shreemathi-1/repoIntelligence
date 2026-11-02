import {
  architectureGraphSchema,
  embedResponseSchema,
  scanResponseSchema,
  scannersResponseSchema,
  type ArchitectureGraph,
  type EmbedResponse,
  type ScanResponse,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';

export interface WorkerClientOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Talks to the Python worker. Every call carries the shared secret header. */
export class WorkerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WorkerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-Worker-Secret': this.options.secret, ...extra };
  }

  async scanners(): Promise<{ tool: string; available: boolean; version: string | null }[]> {
    const response = await this.fetchImpl(`${this.options.url}/v1/scanners`, {
      headers: this.headers(),
    });
    if (!response.ok) throw AppError.upstream(`Worker answered ${response.status}`);
    return scannersResponseSchema.parse(await response.json()).scanners;
  }

  async scan(archive: Buffer, tools?: string[]): Promise<ScanResponse> {
    const query = tools?.length
      ? `?${tools.map((t) => `tools=${encodeURIComponent(t)}`).join('&')}`
      : '';
    const response = await this.post(`/v1/scan${query}`, archive);
    const parsed = scanResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw AppError.upstream('Worker returned an unexpected shape');
    return parsed.data;
  }

  async graph(archive: Buffer): Promise<ArchitectureGraph> {
    const response = await this.post('/v1/graph', archive);
    const parsed = architectureGraphSchema.safeParse(await response.json());
    if (!parsed.success) throw AppError.upstream('Worker returned an unexpected graph shape');
    return parsed.data;
  }

  /** Embeds texts with the worker's local model. At most 256 texts per call. */
  async embed(texts: string[]): Promise<EmbedResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.url}/v1/embed`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 120_000)),
      });
    } catch (err) {
      throw AppError.upstream(
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The worker took too long'
          : 'Could not reach the worker',
      );
    }
    if (!response.ok) throw AppError.upstream(`Worker answered ${response.status}`);
    const parsed = embedResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw AppError.upstream('Worker returned an unexpected embedding shape');
    if (parsed.data.vectors.length !== texts.length) {
      throw AppError.upstream('Worker returned the wrong number of vectors');
    }
    return parsed.data;
  }

  /** Uploads an archive and maps the worker's error statuses to ours. */
  private async post(path: string, archive: Buffer): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.url}${path}`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/gzip' }),
        body: new Uint8Array(archive),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw AppError.upstream(
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The worker took too long'
          : 'Could not reach the worker',
      );
    }
    if (response.status === 413) {
      throw AppError.badRequest('The repository archive is too large to process');
    }
    if (response.status === 422) {
      throw AppError.badRequest('The repository archive could not be unpacked safely');
    }
    if (!response.ok) throw AppError.upstream(`Worker answered ${response.status}`);
    return response;
  }
}
