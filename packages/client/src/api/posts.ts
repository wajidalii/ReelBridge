import type { PlatformType } from '@reelbridge/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client.js';

export type PostTargetStatus =
  | 'pending'
  | 'queued'
  | 'uploading'
  | 'native_scheduled'
  | 'awaiting_app_managed_publish'
  | 'published'
  | 'failed';

export interface Post {
  id: string;
  postItemId: string;
  batchId: string;
  mediaAssetId: string | null;
  originalFilename: string | null;
  publishTargetId: string;
  platform: PlatformType;
  targetDisplayName: string;
  caption: string | null;
  title: string | null;
  status: PostTargetStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  platformPostId: string | null;
  permalinkUrl: string | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PostsFilters {
  platform?: PlatformType;
  status?: PostTargetStatus;
  target?: string;
  from?: string;
  to?: string;
}

interface PostsPage {
  posts: Post[];
  nextCursor: string | null;
}

function buildQuery(filters: PostsFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.status) params.set('status', filters.status);
  if (filters.target) params.set('target', filters.target);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function usePosts(filters: PostsFilters) {
  return useInfiniteQuery({
    queryKey: ['posts', filters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiGet<PostsPage>(`/posts${buildQuery(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useRetryPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => apiPost<Post>(`/posts/${postId}/retry`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['posts'] }),
  });
}
