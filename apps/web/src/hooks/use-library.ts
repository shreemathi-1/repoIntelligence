import {
  collectionListSchema,
  historyListSchema,
  savedListSchema,
  watchChangesSchema,
  watchListSchema,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiNoContent, apiRequest } from '@/lib/api-client';
import { useMe } from '@/hooks/use-me';
import { z } from 'zod';

const base = '/api/v1/me';

/** Library queries only run for signed-in users. */
function useSignedIn(): boolean {
  return Boolean(useMe().data);
}

export function useSaved() {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: ['saved'],
    queryFn: ({ signal }) => apiGet(`${base}/saved`, savedListSchema, signal),
    enabled,
  });
}

export function useCollections() {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: ['collections'],
    queryFn: ({ signal }) => apiGet(`${base}/collections`, collectionListSchema, signal),
    enabled,
  });
}

export function useWatchlist() {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: ['watchlist'],
    queryFn: ({ signal }) => apiGet(`${base}/watchlist`, watchListSchema, signal),
    enabled,
  });
}

export function useWatchChanges(enabled: boolean) {
  return useQuery({
    queryKey: ['watch-changes'],
    queryFn: ({ signal }) => apiGet(`${base}/watchlist/changes`, watchChangesSchema, signal),
    enabled,
    retry: false,
  });
}

export function useHistory() {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: ['history'],
    queryFn: ({ signal }) => apiGet(`${base}/history`, historyListSchema, signal),
    enabled,
  });
}

/** One mutation hook for every library write; it refreshes whatever it touched. */
function useLibraryMutation<V>(run: (value: V) => Promise<unknown>, keys: string[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
}

const fullNameResult = z.object({ fullName: z.string() });

export const useSaveRepo = () =>
  useLibraryMutation(
    (fullName: string) =>
      apiRequest(`${base}/saved`, fullNameResult, { method: 'POST', body: { fullName } }),
    ['saved'],
  );

export const useUnsaveRepo = () =>
  useLibraryMutation(
    (fullName: string) => apiNoContent('DELETE', `${base}/saved/${fullName}`),
    ['saved', 'collections'],
  );

export const useWatchRepo = () =>
  useLibraryMutation(
    (fullName: string) => apiNoContent('PUT', `${base}/watchlist/${fullName}`),
    ['watchlist', 'watch-changes'],
  );

export const useUnwatchRepo = () =>
  useLibraryMutation(
    (fullName: string) => apiNoContent('DELETE', `${base}/watchlist/${fullName}`),
    ['watchlist', 'watch-changes'],
  );

export const useMarkSeen = () =>
  useLibraryMutation(
    (fullName: string) => apiNoContent('POST', `${base}/watchlist/${fullName}/seen`),
    ['watch-changes'],
  );

export const useCreateCollection = () =>
  useLibraryMutation(
    (name: string) =>
      apiRequest(`${base}/collections`, z.object({ id: z.string() }), {
        method: 'POST',
        body: { name },
      }),
    ['collections'],
  );

export const useDeleteCollection = () =>
  useLibraryMutation(
    (id: string) => apiNoContent('DELETE', `${base}/collections/${id}`),
    ['collections'],
  );

export const useClearHistory = () =>
  useLibraryMutation(() => apiNoContent('DELETE', `${base}/history`), ['history']);
