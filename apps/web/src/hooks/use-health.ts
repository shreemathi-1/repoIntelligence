import { healthResponseSchema } from '@repointelligence/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api-client';

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiGet('/health', healthResponseSchema, signal),
    refetchInterval: 30_000,
  });
}
