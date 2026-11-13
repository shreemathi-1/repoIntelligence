import {
  adaptabilityReportSchema,
  alternativesSchema,
  parsedManifestSchema,
  stackProfileListSchema,
  stackProfileSchema,
  type StackProfileInput,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, apiGet, apiNoContent, apiRequest } from '@/lib/api-client';

const PROFILES = '/api/v1/me/stack-profiles';
const repoPath = (fullName: string) => `/api/v1/repos/${fullName}/adaptability`;

export function useStackProfiles(enabled: boolean) {
  return useQuery({
    queryKey: ['stack-profiles'],
    queryFn: ({ signal }) => apiGet(PROFILES, stackProfileListSchema, signal),
    enabled,
    retry: false,
  });
}

/** Creates a profile, or replaces the one with `id`. */
export function useSaveStackProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile }: { id?: string; profile: StackProfileInput }) =>
      apiRequest(id ? `${PROFILES}/${id}` : PROFILES, stackProfileSchema, {
        method: id ? 'PUT' : 'POST',
        body: profile,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['stack-profiles'] }),
  });
}

export function useDeleteStackProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiNoContent('DELETE', `${PROFILES}/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['stack-profiles'] }),
  });
}

export function useParseManifest() {
  return useMutation({
    mutationFn: (body: { filename: string; content: string }) =>
      apiRequest('/api/v1/adaptability/parse-manifest', parsedManifestSchema, {
        method: 'POST',
        body,
      }),
  });
}

export function useEvaluate(fullName: string) {
  return useMutation({
    mutationFn: (profile: StackProfileInput) =>
      apiRequest(repoPath(fullName), adaptabilityReportSchema, { method: 'POST', body: { profile } }),
  });
} // prettier-ignore

export function useAlternatives(fullName: string) {
  return useMutation({
    mutationFn: (profile: StackProfileInput) =>
      apiRequest(`${repoPath(fullName)}/alternatives`, alternativesSchema, { method: 'POST', body: { profile } }),
  });
} // prettier-ignore

export function useExplainReport() {
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/adaptability/${id}/explain`, adaptabilityReportSchema, { method: 'POST' }),
  });
} // prettier-ignore

export function useSaveChecklist() {
  return useMutation({
    mutationFn: ({ id, done }: { id: string; done: string[] }) =>
      apiRequest(`/api/v1/adaptability/${id}/checklist`, adaptabilityReportSchema, { method: 'PUT', body: { done } }),
  });
} // prettier-ignore

export const reportExportUrl = (id: string, format: 'markdown' | 'html' | 'json'): string =>
  `${API_BASE_URL}/api/v1/adaptability/${id}/export?format=${format}`;
