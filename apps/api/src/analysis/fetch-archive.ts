import { AppError } from '../errors.js';

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export interface ArchiveSource {
  fetch?: typeof fetch;
  token?: string;
}

/**
 * Downloads the gzipped tarball of one commit. GitHub redirects to codeload, and the body is
 * read in chunks so an oversized archive stops early instead of filling memory.
 */
export async function fetchArchive(
  owner: string,
  name: string,
  sha: string,
  source: ArchiveSource,
): Promise<Buffer> {
  const fetchImpl = source.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'repointelligence',
  };
  if (source.token) headers.Authorization = `Bearer ${source.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${owner}/${name}/tarball/${sha}`, {
      headers,
      redirect: 'follow',
    });
  } catch {
    throw AppError.upstream('Could not download the repository archive');
  }
  if (response.status === 404) throw AppError.notFound('Repository or commit not found on GitHub');
  if (response.status === 403 || response.status === 429) throw AppError.rateLimited();
  if (!response.ok || !response.body)
    throw AppError.upstream(`GitHub answered ${response.status} for the archive`);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw AppError.badRequest('The repository archive is larger than the 50 MB limit');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Node types leave the body untyped; it is a byte stream.
  const stream: unknown = response.body;
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw AppError.badRequest('The repository archive is larger than the 50 MB limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
