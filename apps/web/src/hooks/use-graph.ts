import {
  graphDiffSchema,
  graphRunSchema,
  graphSummarySchema,
  graphViewResponseSchema,
  sourceFileSchema,
  traceResponseSchema,
  type GraphRun,
  type GraphView,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, ApiError, apiGet, apiRequest, queryString } from '@/lib/api-client';

const repoPath = (fullName: string) => `/api/v1/repos/${fullName}`;
const ACTIVE = new Set<GraphRun['status']>(['queued', 'running']);

/** The newest stored graph summary, or null when none has been built. */
export function useGraphSummary(fullName: string) {
  return useQuery({
    queryKey: ['graph', fullName],
    queryFn: async ({ signal }) => {
      try {
        return await apiGet(`${repoPath(fullName)}/graph/latest`, graphSummarySchema, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useGraphView(
  fullName: string,
  sha: string | null,
  view: GraphView,
  folder?: string,
  file?: string,
) {
  return useQuery({
    queryKey: ['graph-view', fullName, sha, view, folder, file],
    queryFn: ({ signal }) =>
      apiGet(
        `${repoPath(fullName)}/graph/${sha ?? ''}/view${queryString({ view, folder, file })}`,
        graphViewResponseSchema,
        signal,
      ),
    enabled: sha !== null,
    staleTime: Infinity,
  });
}

export function useStartGraph(fullName: string) {
  return useMutation({
    mutationFn: (body: { force?: boolean }) =>
      apiRequest(`${repoPath(fullName)}/graph`, graphRunSchema, { method: 'POST', body }),
  });
}

export function useGraphRun(runId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['graph-run', runId],
    queryFn: async ({ signal }) => {
      const run = await apiGet(`/api/v1/graph-builds/${runId ?? ''}`, graphRunSchema, signal);
      if (!ACTIVE.has(run.status)) {
        await queryClient.invalidateQueries({ queryKey: ['graph', run.fullName] });
      }
      return run;
    },
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.status) ? 2000 : false,
    retry: false,
  });
}

export function useTrace(fullName: string, sha: string | null, route: string | null) {
  return useQuery({
    queryKey: ['graph-trace', fullName, sha, route],
    queryFn: ({ signal }) =>
      apiGet(
        `${repoPath(fullName)}/graph/${sha ?? ''}/trace${queryString({ route: route ?? undefined })}`,
        traceResponseSchema,
        signal,
      ),
    enabled: sha !== null && route !== null,
    staleTime: Infinity,
  });
}

export function useGraphDiff(fullName: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ['graph-diff', fullName, from, to],
    queryFn: ({ signal }) =>
      apiGet(
        `${repoPath(fullName)}/graph/diff${queryString({ from: from ?? undefined, to: to ?? undefined })}`,
        graphDiffSchema,
        signal,
      ),
    enabled: Boolean(from && to && from !== to),
    retry: false,
  });
}

export function useSource(fullName: string, sha: string | null, path: string | null) {
  return useQuery({
    queryKey: ['source', fullName, sha, path],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/source/${sha ?? ''}/${path ?? ''}`, sourceFileSchema, signal),
    enabled: sha !== null && path !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export function mermaidUrl(fullName: string, sha: string, diagram: string): string {
  return `${API_BASE_URL}${repoPath(fullName)}/graph/${sha}/mermaid?diagram=${diagram}`;
}
