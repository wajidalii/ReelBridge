import type { PlatformCapabilities, PlatformType } from '@reelbridge/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client.js';

export interface Target {
  id: string;
  platform: PlatformType;
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  timezone: string | null;
  isActive: boolean;
  capabilities: PlatformCapabilities;
}

export function useTargets() {
  return useQuery({
    queryKey: ['targets'],
    queryFn: () => apiGet<Target[]>('/targets'),
  });
}
