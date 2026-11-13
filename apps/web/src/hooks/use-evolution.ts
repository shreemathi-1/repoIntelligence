import {
  activitySchema,
  architectureEvolutionSchema,
  compareSchema,
  languagesSchema,
  qualitySchema,
  releaseSummarySchema,
  releasesSchema,
  snapshotCompareSchema,
  timelineSchema,
  type ReleaseSummaryRequest,
} from '@repointelligence/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiRequest, queryString } from '@/lib/api-client';

export type Weeks = 12 | 26 | 52;

const path = (fullName: string, rest: string) => `/api/v1/repos/${fullName}/evolution/${rest}`;

export function useActivity(fullName: string, weeks: Weeks) {
  return useQuery({
    queryKey: ['evolution', fullName, 'activity', weeks],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, `activity${queryString({ weeks })}`), activitySchema, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useTimeline(fullName: string, page: number) {
  return useQuery({
    queryKey: ['evolution', fullName, 'timeline', page],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, `timeline${queryString({ page })}`), timelineSchema, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useReleases(fullName: string, weeks: Weeks) {
  return useQuery({
    queryKey: ['evolution', fullName, 'releases', weeks],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, `releases${queryString({ weeks })}`), releasesSchema, signal),
    retry: false,
  });
}

export function useCompare(fullName: string, base: string, head: string) {
  return useQuery({
    queryKey: ['evolution', fullName, 'compare', base, head],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, `compare${queryString({ base, head })}`), compareSchema, signal),
    enabled: Boolean(base && head),
    retry: false,
  });
}

export function useLanguages(fullName: string) {
  return useQuery({
    queryKey: ['evolution', fullName, 'languages'],
    queryFn: ({ signal }) => apiGet(path(fullName, 'languages'), languagesSchema, signal),
    retry: false,
  });
}

export function useQuality(fullName: string) {
  return useQuery({
    queryKey: ['evolution', fullName, 'quality'],
    queryFn: ({ signal }) => apiGet(path(fullName, 'quality'), qualitySchema, signal),
    retry: false,
  });
}

export function useSnapshotCompare(fullName: string, a: string, b: string) {
  return useQuery({
    queryKey: ['evolution', fullName, 'snapshots', a, b],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, `snapshots/compare${queryString({ a, b })}`), snapshotCompareSchema, signal),
    enabled: Boolean(a && b && a !== b),
    retry: false,
  });
} // prettier-ignore

export function useArchitectureEvolution(fullName: string) {
  return useQuery({
    queryKey: ['evolution', fullName, 'architecture'],
    queryFn: ({ signal }) =>
      apiGet(path(fullName, 'architecture'), architectureEvolutionSchema, signal),
    retry: false,
  });
}

export function useReleaseSummary(fullName: string) {
  return useMutation({
    mutationFn: (body: ReleaseSummaryRequest) =>
      apiRequest(path(fullName, 'release-summary'), releaseSummarySchema, { method: 'POST', body }),
  });
}
