import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { PlatformType } from '../platform-adapter.js';

/**
 * Per-platform metrics (issue #39). Everything is labelled by `platform` and
 * never pre-aggregated across platforms: Instagram's app-managed scheduling
 * has a structurally different reliability profile from Facebook/YouTube's
 * native scheduling (PROJECT.md NFRs), so a blended success rate would hide
 * an Instagram-only regression.
 */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const publishAttemptsTotal = new Counter({
  name: 'reelbridge_publish_attempts_total',
  help: 'Publish attempts by platform and outcome',
  labelNames: ['platform', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const publishDurationSeconds = new Histogram({
  name: 'reelbridge_publish_duration_seconds',
  help: 'Wall-clock time of a single publish attempt (upload + platform calls)',
  labelNames: ['platform'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

export const publishLatenessSeconds = new Histogram({
  name: 'reelbridge_publish_lateness_seconds',
  help: 'Actual publish start minus scheduled_at, for app-managed (Instagram) publishes',
  labelNames: ['platform'] as const,
  buckets: [5, 20, 60, 300, 900, 3600, 21600, 86400],
  registers: [metricsRegistry],
});

export const appManagedLateTotal = new Counter({
  name: 'reelbridge_app_managed_publish_late_total',
  help: 'awaiting_app_managed_publish rows found past the lateness threshold by the due-job sweep',
  labelNames: ['platform'] as const,
  registers: [metricsRegistry],
});

export const quotaDeferralsTotal = new Counter({
  name: 'reelbridge_quota_deferrals_total',
  help: 'Publish jobs deferred because a per-account/per-project platform quota was exhausted',
  labelNames: ['platform'] as const,
  registers: [metricsRegistry],
});

export const healthCheckResultsTotal = new Counter({
  name: 'reelbridge_health_check_results_total',
  help: 'Token health check outcomes by platform',
  labelNames: ['platform', 'result'] as const,
  registers: [metricsRegistry],
});

export const postTargetsByStatus = new Gauge({
  name: 'reelbridge_post_targets',
  help: 'Current number of post_targets rows by platform and status (sampled periodically)',
  labelNames: ['platform', 'status'] as const,
  registers: [metricsRegistry],
});

export const activePublishWorkers = new Gauge({
  name: 'reelbridge_active_publish_workers',
  help: 'Per-target publish workers currently running in this worker process',
  labelNames: ['platform'] as const,
  registers: [metricsRegistry],
});

export const sweepRunsTotal = new Counter({
  name: 'reelbridge_sweep_runs_total',
  help: 'Cron sweep executions by sweep name and outcome',
  labelNames: ['sweep', 'outcome'] as const,
  registers: [metricsRegistry],
});

export function recordPublishOutcome(
  platform: PlatformType | string,
  outcome: 'published' | 'native_scheduled' | 'failed' | 'deferred',
  durationSeconds?: number,
): void {
  publishAttemptsTotal.inc({ platform, outcome });
  if (durationSeconds !== undefined) {
    publishDurationSeconds.observe({ platform }, durationSeconds);
  }
}
