import {
  askResponseSchema,
  chatSessionSchema,
  chatStatusSchema,
  explainResponseSchema,
  suggestionsSchema,
  type ExplainRequest,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, apiGet, apiRequest } from '@/lib/api-client';

const repoPath = (fullName: string) => `/api/v1/repos/${fullName}`;
const BUILDING = new Set(['queued', 'running']);

export function useChatStatus(fullName: string) {
  return useQuery({
    queryKey: ['chat-status', fullName],
    queryFn: ({ signal }) => apiGet(`${repoPath(fullName)}/chat/status`, chatStatusSchema, signal),
    // While vectors are being built, check back so the label updates by itself.
    refetchInterval: (query) =>
      query.state.data && BUILDING.has(query.state.data.embedding.status) ? 4000 : false,
    retry: false,
  });
}

export function useSuggestions(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat-suggestions', fullName],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/chat/suggestions`, suggestionsSchema, signal),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useCreateSession(fullName: string) {
  return useMutation({
    mutationFn: () =>
      apiRequest(`${repoPath(fullName)}/chat/sessions`, chatSessionSchema, { method: 'POST' }),
  });
}

export function useAsk() {
  return useMutation({
    mutationFn: ({ sessionId, question }: { sessionId: string; question: string }) =>
      apiRequest(`/api/v1/chat/sessions/${sessionId}/messages`, askResponseSchema, {
        method: 'POST',
        body: { question },
      }),
  });
}

export function useBuildIndex(fullName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest(`${repoPath(fullName)}/chat/index`, chatStatusSchema, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (status) => {
      queryClient.setQueryData(['chat-status', fullName], status);
    },
  });
}

export function useExplain(fullName: string) {
  return useMutation({
    mutationFn: (request: ExplainRequest) =>
      apiRequest(`${repoPath(fullName)}/explain`, explainResponseSchema, {
        method: 'POST',
        body: request,
      }),
  });
}

export function exportUrl(sessionId: string): string {
  return `${API_BASE_URL}/api/v1/chat/sessions/${sessionId}/export.md`;
}
