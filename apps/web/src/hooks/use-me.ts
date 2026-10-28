import {
  meResponseSchema,
  preferencesSchema,
  type Preferences,
  type PreferencesUpdate,
  type PublicUser,
} from '@repointelligence/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiPostNoContent, apiRequest } from '@/lib/api-client';

const ME_KEY = ['me'] as const;

/** The signed-in user, or null when nobody is signed in. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async ({ signal }): Promise<PublicUser | null> => {
      try {
        return (await apiRequest('/api/v1/me', meResponseSchema, { signal })).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: PreferencesUpdate): Promise<Preferences> =>
      apiRequest('/api/v1/me/preferences', preferencesSchema, { method: 'PATCH', body: update }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPostNoContent('/api/v1/auth/logout'),
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
