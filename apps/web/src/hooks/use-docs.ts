import {
  docDriftSchema,
  docListSchema,
  docPullRequestSchema,
  docQuotaSchema,
  docReviewSchema,
  generatedDocSchema,
  missingDocsSchema,
  type DocPullRequestRequest,
  type GenerateDocRequest,
  type UpdateDocRequest,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, apiGet, apiRequest, queryString } from '@/lib/api-client';

const repoPath = (fullName: string) => `/api/v1/repos/${fullName}`;

export function useDocList(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['docs', fullName],
    queryFn: ({ signal }) => apiGet(`${repoPath(fullName)}/docs`, docListSchema, signal),
    enabled,
    retry: false,
  });
}

export function useDoc(id: string | null) {
  return useQuery({
    queryKey: ['doc', id],
    queryFn: ({ signal }) => apiGet(`/api/v1/docs/${id ?? ''}`, generatedDocSchema, signal),
    enabled: id !== null,
    retry: false,
  });
}

export function useMissingDocs(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['docs-missing', fullName],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/docs/missing`, missingDocsSchema, signal),
    enabled,
    retry: false,
  });
}

export function useDocQuota(enabled: boolean) {
  return useQuery({
    queryKey: ['docs-quota'],
    queryFn: ({ signal }) => apiGet('/api/v1/me/docs-quota', docQuotaSchema, signal),
    enabled,
    retry: false,
  });
}

export function useDrift(id: string | null) {
  return useQuery({
    queryKey: ['doc-drift', id],
    queryFn: ({ signal }) => apiGet(`/api/v1/docs/${id ?? ''}/drift`, docDriftSchema, signal),
    enabled: id !== null,
    retry: false,
  });
}

export function useGenerateDoc(fullName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateDocRequest) =>
      apiRequest(`${repoPath(fullName)}/docs`, generatedDocSchema, { method: 'POST', body }),
    onSuccess: async (doc) => {
      queryClient.setQueryData(['doc', doc.id], doc);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['docs', fullName] }),
        queryClient.invalidateQueries({ queryKey: ['docs-quota'] }),
      ]);
    },
  });
}

export function useSaveDoc(fullName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateDocRequest & { id: string }) =>
      apiRequest(`/api/v1/docs/${id}`, generatedDocSchema, { method: 'PATCH', body }),
    onSuccess: async (doc) => {
      queryClient.setQueryData(['doc', doc.id], doc);
      await queryClient.invalidateQueries({ queryKey: ['docs', fullName] });
    },
  });
}

export function useReviewDoc() {
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/docs/${id}/review`, docReviewSchema, { method: 'POST' }),
  });
}

export function useProposePullRequest() {
  return useMutation({
    mutationFn: (body: DocPullRequestRequest) =>
      apiRequest('/api/v1/docs/pull-requests', docPullRequestSchema, { method: 'POST', body }),
  });
}

export function docExportUrl(
  id: string,
  format: 'markdown' | 'html',
  links: 'github' | 'relative',
): string {
  return `${API_BASE_URL}/api/v1/docs/${id}/export${queryString({ format, links })}`;
}
