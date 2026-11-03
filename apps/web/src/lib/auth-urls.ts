import { API_BASE_URL } from './api-client';

export function loginUrl(privateRepos = false, docsWrite = false): string {
  const params = new URLSearchParams();
  if (privateRepos) params.set('privateRepos', '1');
  if (docsWrite) params.set('docsWrite', '1');
  const query = params.toString();
  return `${API_BASE_URL}/api/v1/auth/github/login${query ? `?${query}` : ''}`;
}
