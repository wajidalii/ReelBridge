import { randomUUID } from 'node:crypto';
import { PLATFORM_CAPABILITIES } from './platform-adapter.js';
import type {
  CaptionPayload,
  MediaAssetRef,
  PlatformAdapter,
  PlatformType,
  PublishResult,
  StatusResult,
  TargetDescriptor,
  ValidationWarning,
} from './platform-adapter.js';

/**
 * No-op adapter used by server/worker tests before real platform adapters land.
 * Never calls a real API; publish() resolves deterministically based on whether
 * the platform natively schedules, per PLATFORM_CAPABILITIES.
 */
export function createMockAdapter(platform: PlatformType): PlatformAdapter {
  const capabilities = PLATFORM_CAPABILITIES[platform];

  return {
    platform,
    capabilities,

    async discoverTargets(_connectionId: string): Promise<TargetDescriptor[]> {
      return [
        {
          externalId: `mock-${platform}-target`,
          displayName: `Mock ${platform} target`,
        },
      ];
    },

    async publish(
      _target: TargetDescriptor,
      _mediaAsset: MediaAssetRef,
      _captionPayload: CaptionPayload,
      scheduledAt?: Date,
    ): Promise<PublishResult> {
      const platformPostId = randomUUID();
      if (!scheduledAt) {
        return { platformPostId, status: 'published' };
      }
      return {
        platformPostId,
        status: capabilities.nativeScheduling ? 'native_scheduled' : 'awaiting_app_managed_publish',
      };
    },

    async checkStatus(_target: TargetDescriptor, _platformPostId: string): Promise<StatusResult> {
      return { status: 'published' };
    },

    validateMediaConstraints(_mediaAsset: MediaAssetRef): ValidationWarning[] {
      return [];
    },
  };
}
