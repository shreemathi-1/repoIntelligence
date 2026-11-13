import {
  implementationPlanSchema,
  onboardingSchema,
  planListSchema,
  starterIssuesSchema,
  type LearningMode,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, apiGet, apiNoContent, apiRequest } from '@/lib/api-client';

const repoPath = (fullName: string) => `/api/v1/repos/${fullName}`;

export function useOnboarding(fullName: string, mode: LearningMode, enabled: boolean) {
  return useQuery({
    queryKey: ['onboarding', fullName, mode],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/onboarding?mode=${mode}`, onboardingSchema, signal),
    enabled,
    retry: false,
  });
}

export function useSaveOnboardingProgress(fullName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (done: string[]) =>
      apiNoContent('PUT', `${repoPath(fullName)}/onboarding/progress`, { done }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['onboarding', fullName] }),
  });
}

export function useStarterIssues(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['starter-issues', fullName],
    queryFn: ({ signal }) =>
      apiGet(`${repoPath(fullName)}/starter-issues`, starterIssuesSchema, signal),
    enabled,
    retry: false,
  });
}

export function usePlans(fullName: string, enabled: boolean) {
  return useQuery({
    queryKey: ['plans', fullName],
    queryFn: ({ signal }) => apiGet(`${repoPath(fullName)}/plans`, planListSchema, signal),
    enabled,
    retry: false,
  });
}

export function usePlan(id: string | null) {
  return useQuery({
    queryKey: ['plan', id],
    queryFn: ({ signal }) => apiGet(`/api/v1/plans/${id ?? ''}`, implementationPlanSchema, signal),
    enabled: id !== null,
    retry: false,
  });
}

export function useCreatePlan(fullName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (goal: string) =>
      apiRequest(`${repoPath(fullName)}/plans`, implementationPlanSchema, {
        method: 'POST',
        body: { goal },
      }),
    onSuccess: (plan) => {
      client.setQueryData(['plan', plan.id], plan);
      return client.invalidateQueries({ queryKey: ['plans', fullName] });
    },
  });
}

export function useSavePlanProgress(fullName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, done }: { id: string; done: string[] }) =>
      apiRequest(`/api/v1/plans/${id}/progress`, implementationPlanSchema, {
        method: 'PUT',
        body: { done },
      }),
    onSuccess: (plan) => {
      client.setQueryData(['plan', plan.id], plan);
      return client.invalidateQueries({ queryKey: ['plans', fullName] });
    },
  });
}

export function useDeletePlan(fullName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiNoContent('DELETE', `/api/v1/plans/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['plans', fullName] }),
  });
}

export const planExportUrl = (id: string, format: 'markdown' | 'issue'): string =>
  `${API_BASE_URL}/api/v1/plans/${id}/export?format=${format}`;
