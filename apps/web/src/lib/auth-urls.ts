import { API_BASE_URL } from './api-client';

export function loginUrl(privateRepos = false): string {
  return `${API_BASE_URL}/api/v1/auth/github/login${privateRepos ? '?privateRepos=1' : ''}`;
}
