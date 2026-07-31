import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client.js';

export interface AppConfig {
  metaAppReviewApproved: boolean;
  youtubeComplianceApproved: boolean;
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => apiGet<AppConfig>('/config'),
    staleTime: Infinity,
  });
}
