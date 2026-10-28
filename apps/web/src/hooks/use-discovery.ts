import {
  compareResponseSchema,
  contributeResponseSchema,
  searchResponseSchema,
  trendingResponseSchema,
  trendingTopicsResponseSchema,
} from '@repointelligence/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet, queryString } from '@/lib/api-client';

export type SearchValues = Record<string, string | undefined>;

export function useSearch(values: SearchValues, enabled: boolean) {
  return useQuery({
    queryKey: ['search', values],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/search${queryString(values)}`, searchResponseSchema, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useContribute(language: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['contribute', language],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/contribute${queryString({ language })}`, contributeResponseSchema, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useTrending(period: string, topic: string | undefined) {
  return useQuery({
    queryKey: ['trending', period, topic],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/trending${queryString({ period, topic })}`, trendingResponseSchema, signal),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useTrendingTopics() {
  return useQuery({
    queryKey: ['trending-topics'],
    queryFn: ({ signal }) =>
      apiGet('/api/v1/trending/topics', trendingTopicsResponseSchema, signal),
    staleTime: Infinity,
  });
}

export function useCompare(repos: string[]) {
  return useQuery({
    queryKey: ['compare', repos],
    queryFn: ({ signal }) =>
      apiGet(
        `/api/v1/compare${queryString({ repos: repos.join(',') })}`,
        compareResponseSchema,
        signal,
      ),
    enabled: repos.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
