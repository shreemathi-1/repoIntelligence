import {
  freshnessSchema,
  ingestionSchema,
  repoResponseSchema,
  type IngestRequest,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiRequest } from '@/lib/api-client';

const path = (fullName: string) => `/api/v1/repos/${fullName}`;

export function useRepo(fullName: string) {
  return useQuery({
    queryKey: ['repo', fullName],
    queryFn: ({ signal }) => apiGet(path(fullName), repoResponseSchema, signal),
    retry: false,
  });
}

/** The newest finished ingestion, or null when the repository has not been ingested. */
export function useLatestIngestion(fullName: string) {
  return useQuery({
    queryKey: ['ingestion', fullName],
    queryFn: async ({ signal }) => {
      try {
        return await apiGet(`${path(fullName)}/ingestions/latest`, ingestionSchema, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useFreshness(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['freshness', fullName],
    queryFn: ({ signal }) => apiGet(`${path(fullName)}/freshness`, freshnessSchema, signal),
    enabled,
    retry: false,
  });
}

export function useIngest(fullName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: IngestRequest) =>
      apiRequest(`${path(fullName)}/ingest`, ingestionSchema, { method: 'POST', body: request }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ingestion', fullName] }),
        queryClient.invalidateQueries({ queryKey: ['freshness', fullName] }),
      ]);
    },
  });
}
