export type PlatformType = 'facebook_page' | 'instagram_business' | 'youtube_channel';

export type UploadMechanism = 'binary' | 'resumable' | 'url-fetch';

export type CaptionShape = 'single-text' | 'title-plus-description';

/**
 * Describes what a platform can and cannot do so callers (server validation/preview,
 * worker publishing, dashboard UI) can reason about a target without importing a
 * concrete platform package.
 */
export interface PlatformCapabilities {
  nativeScheduling: boolean;
  maxScheduleLeadDays: number | null;
  minScheduleLeadMinutes: number | null;
  uploadMechanism: UploadMechanism;
  captionShape: CaptionShape;
}

export const PLATFORM_CAPABILITIES: Record<PlatformType, PlatformCapabilities> = {
  facebook_page: {
    nativeScheduling: true,
    maxScheduleLeadDays: 29,
    minScheduleLeadMinutes: 10,
    uploadMechanism: 'binary',
    captionShape: 'single-text',
  },
  instagram_business: {
    nativeScheduling: false,
    maxScheduleLeadDays: null,
    minScheduleLeadMinutes: null,
    uploadMechanism: 'url-fetch',
    captionShape: 'single-text',
  },
  youtube_channel: {
    nativeScheduling: true,
    maxScheduleLeadDays: null,
    minScheduleLeadMinutes: null,
    uploadMechanism: 'resumable',
    captionShape: 'title-plus-description',
  },
};

export interface TargetDescriptor {
  externalId: string;
  displayName: string;
  avatarUrl?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaAssetRef {
  mediaAssetId: string;
  storageKey: string;
  originalFilename: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface CaptionPayload {
  caption: string;
  title?: string;
}

export interface PublishResult {
  platformPostId: string;
  /**
   * 'native_scheduled': the platform itself holds the future publish action (FB, YouTube).
   * 'awaiting_app_managed_publish': ReelBridge's own worker must act again at publish time (Instagram).
   * 'published': publish happened immediately, no scheduling was involved.
   */
  status: 'native_scheduled' | 'awaiting_app_managed_publish' | 'published';
  permalinkUrl?: string;
}

export interface StatusResult {
  status: 'pending' | 'published' | 'failed';
  permalinkUrl?: string;
  errorMessage?: string;
}

/**
 * 'blocking': the platform will actively reject this (e.g. duration outside
 * the accepted range) — the UI must prevent scheduling until resolved.
 * 'warning': non-ideal but the platform will still accept it (e.g. aspect
 * ratio, which most platforms crop/pad rather than reject).
 */
export type ValidationSeverity = 'blocking' | 'warning';

export type ValidationAffectedField = 'duration' | 'aspectRatio' | 'resolution' | 'fileSize';

export interface ValidationWarning {
  code: string;
  severity: ValidationSeverity;
  message: string;
  affectedField: ValidationAffectedField;
}

export interface PlatformAdapter {
  platform: PlatformType;
  capabilities: PlatformCapabilities;

  discoverTargets(connectionId: string): Promise<TargetDescriptor[]>;

  publish(
    target: TargetDescriptor,
    mediaAsset: MediaAssetRef,
    captionPayload: CaptionPayload,
    scheduledAt?: Date,
  ): Promise<PublishResult>;

  checkStatus(target: TargetDescriptor, platformPostId: string): Promise<StatusResult>;

  validateMediaConstraints(mediaAsset: MediaAssetRef): ValidationWarning[];
}
