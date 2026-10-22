import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet } from './client.js';

export interface Connection {
  id: string;
  platform: 'facebook' | 'google';
  displayName: string;
  externalAccountId: string;
  status: 'active' | 'expired' | 'revoked';
  scopes: string[];
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  targetCount: number;
}

export const CONNECTIONS_QUERY_KEY = ['connections'] as const;

export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => apiGet<Connection[]>('/connections'),
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => apiDelete(`/connections/${connectionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
  });
}
