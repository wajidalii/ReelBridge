import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client.js';

export interface UsageResponse {
  plan: {
    name: string;
    maxTargets: number;
    maxPostsPerMonth: number;
    subscriptionStatus: string | null;
  };
  activeTargets: number;
  postsThisMonth: number;
  enforced: boolean;
}

export function useUsage() {
  return useQuery({
    queryKey: ['billing', 'usage'],
    queryFn: () => apiGet<UsageResponse>('/billing/usage'),
  });
}
