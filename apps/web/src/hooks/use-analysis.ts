import {
  analysisRunSchema,
  healthHistorySchema,
  quotaSchema,
  simulateResponseSchema,
  type AnalysisRun,
  type SimulateRequest,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiRequest } from '@/lib/api-client';

const repoPath = (fullName: string) => `/api/v1/repos/${fullName}`;
const ACTIVE = new Set<AnalysisRun['status']>(['queued', 'running']);

/** The newest finished score, or null when the repository has never been analysed. */
export function useHealth(fullName: string) {
  return useQuery({
    queryKey: ['health', fullName],
    queryFn: async ({ signal }) => {
      try {
        return await apiGet(`${repoPath(fullName)}/health`, analysisRunSchema, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

/** Polls a run while it is queued or running, then refreshes the score and history. */
export function useAnalysisRun(runId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['analysis', runId],
    queryFn: async ({ signal }) => {
      const run = await apiGet(`/api/v1/analyses/${runId ?? ''}`, analysisRunSchema, signal);
      if (!ACTIVE.has(run.status)) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['health', run.fullName] }),
          queryClient.invalidateQueries({ queryKey: ['health-history', run.fullName] }),
          queryClient.invalidateQueries({ queryKey: ['quota'] }),
        ]);
      }
      return run;
    },
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.status) ? 2000 : false,
    retry: false,
  });
}

export function useStartAnalysis(fullName: string) {
  return useMutation({
    mutationFn: (body: { force?: boolean }) =>
      apiRequest(`${repoPath(fullName)}/analyze`, analysisRunSchema, { method: 'POST', body }),
  });
}

export function useCancelAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest(`/api/v1/analyses/${runId}/cancel`, analysisRunSchema, { method: 'POST' }),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: ['analysis', run.id] });
    },
  });
}

export function useHealthHistory(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['health-history', fullName],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/health/history`, healthHistorySchema, signal),
    enabled,
  });
}

export function useSimulate(fullName: string) {
  return useMutation({
    mutationFn: (request: SimulateRequest) =>
      apiRequest(`${repoPath(fullName)}/health/simulate`, simulateResponseSchema, {
        method: 'POST',
        body: request,
      }),
  });
}

export function useQuota(enabled: boolean) {
  return useQuery({
    queryKey: ['quota'],
    queryFn: ({ signal }) => apiGet('/api/v1/me/analysis-quota', quotaSchema, signal),
    enabled,
  });
}
