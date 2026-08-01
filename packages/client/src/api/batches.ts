import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from './client.js';

export interface BatchMedia {
  id: string;
  originalFilename: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export interface PostTargetRow {
  id: string;
  postItemId: string;
  publishTargetId: string;
  captionOverride: string | null;
  titleOverride: string | null;
  scheduledAt: string | null;
  status: string;
}

export interface BatchItem {
  id: string;
  batchId: string;
  mediaAssetId: string;
  defaultCaption: string;
  defaultTitle: string | null;
  media: BatchMedia | null;
  targets: PostTargetRow[];
}

export interface Batch {
  id: string;
  name: string;
  status: string;
  items: BatchItem[];
}

export function useBatch(batchId: string | undefined) {
  return useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => apiGet<Batch>(`/batches/${batchId}`),
    enabled: batchId !== undefined,
  });
}

export interface AssignTargetInput {
  publish_target_id: string;
  caption_override?: string;
  title_override?: string;
  scheduled_at?: string;
}

interface AssignTargetsResponse {
  created: PostTargetRow[];
  rejected: Array<{ publish_target_id: string; error: string }>;
}

export function assignTargets(
  batchId: string,
  itemId: string,
  targets: AssignTargetInput[],
): Promise<AssignTargetsResponse> {
  return apiPost<AssignTargetsResponse>(`/batches/${batchId}/items/${itemId}/targets`, {
    targets,
  });
}

interface AutoDistributeResponse {
  assignments: Array<{ item_id: string; scheduled_at: string }>;
  leftoverCount: number;
}

export function autoDistribute(
  batchId: string,
  publishTargetId: string,
  itemIds: string[],
  dailySlotTimes: string[],
): Promise<AutoDistributeResponse> {
  return apiPost<AutoDistributeResponse>(`/batches/${batchId}/auto-distribute`, {
    publish_target_id: publishTargetId,
    item_ids: itemIds,
    daily_slot_times: dailySlotTimes,
  });
}
