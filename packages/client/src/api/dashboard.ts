import type { PlatformType } from '@reelbridge/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client.js';
import type { PostTargetStatus } from './posts.js';

export interface DashboardTargetSummary {
  id: string;
  platform: PlatformType;
  displayName: string;
  isActive: boolean;
  lastValidatedAt: string | null;
}

export interface DashboardUpcoming {
  id: string;
  platform: PlatformType;
  targetDisplayName: string;
  originalFilename: string | null;
  scheduledAt: string | null;
  status: PostTargetStatus;
}

export interface DashboardFailure {
  id: string;
  platform: PlatformType;
  targetDisplayName: string;
  originalFilename: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface DashboardResponse {
  targets: {
    total: number;
    active: number;
    needsAttention: DashboardTargetSummary[];
    byPlatform: Partial<Record<PlatformType, number>>;
  };
  posts: {
    countsByPlatform: Partial<Record<PlatformType, Partial<Record<PostTargetStatus, number>>>>;
  };
  batches: { total: number };
  upcoming: DashboardUpcoming[];
  recentFailures: DashboardFailure[];
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiGet<DashboardResponse>('/dashboard'),
    refetchInterval: 30_000,
  });
}
