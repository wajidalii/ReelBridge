import type { PlatformCapabilities, PlatformType } from '@reelbridge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut } from './client.js';

export type TargetHealth = 'healthy' | 'needs_reconnect' | 'revoked' | 'unchecked';

export interface Target {
  id: string;
  platform: PlatformType;
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  timezone: string | null;
  isActive: boolean;
  tokenSource: 'oauth' | 'manual';
  connectedAt: string;
  lastValidatedAt: string | null;
  health: TargetHealth;
  connectionId: string;
  connectionStatus: 'active' | 'expired' | 'revoked' | null;
  username: string | null;
  linkedFacebookPageId: string | null;
  lastHealthError: string | null;
  capabilities: PlatformCapabilities;
}

export const TARGETS_QUERY_KEY = ['targets'] as const;

export function useTargets() {
  return useQuery({
    queryKey: TARGETS_QUERY_KEY,
    queryFn: () => apiGet<Target[]>('/targets'),
  });
}

export function useRevalidateTarget() {
  return useMutation({
    mutationFn: (targetId: string) =>
      apiPost<{ queued: boolean }>(`/targets/${targetId}/revalidate`, {}),
  });
}

export function useDeleteTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) => apiDelete(`/targets/${targetId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TARGETS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
  });
}

// --- recurring schedule (issue #48) ----------------------------------------

export type ScheduleCadence = 'hourly' | 'every_6_hours' | 'daily' | 'weekly';

export interface ScheduleConfig {
  publishTargetId: string;
  dailySlots: string[];
  timezone: string;
  maxScheduleDays: number;
  minLeadMinutes: number;
  cadence: ScheduleCadence;
  nextRunAt: string | null;
  lastRunAt: string | null;
  isEnabled: boolean;
  platformMaxScheduleDays: number;
}

export interface ScheduleRun {
  id: string;
  publishTargetId: string;
  triggeredBy: 'cron' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  itemsConsidered: number;
  itemsScheduled: number;
  itemsLeftover: number;
  status: 'running' | 'completed' | 'failed';
  errorMessage: string | null;
}

export interface ScheduleConfigResponse {
  config: ScheduleConfig | null;
  platformMaxScheduleDays: number;
  recentRuns: ScheduleRun[];
}

export function scheduleConfigQueryKey(targetId: string) {
  return ['targets', targetId, 'schedule-config'] as const;
}

export function useScheduleConfig(targetId: string, enabled = true) {
  return useQuery({
    queryKey: scheduleConfigQueryKey(targetId),
    queryFn: () => apiGet<ScheduleConfigResponse>(`/targets/${targetId}/schedule/config`),
    enabled,
  });
}

export interface ScheduleConfigInput {
  daily_slots: string[];
  timezone: string;
  cadence: ScheduleCadence;
  max_schedule_days: number;
  is_enabled: boolean;
}

export function useSaveScheduleConfig(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleConfigInput) =>
      apiPut<ScheduleConfig>(`/targets/${targetId}/schedule/config`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: scheduleConfigQueryKey(targetId) }),
  });
}

export function useTriggerSchedule(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ queued: boolean }>(`/targets/${targetId}/schedule/trigger`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: scheduleConfigQueryKey(targetId) }),
  });
}
