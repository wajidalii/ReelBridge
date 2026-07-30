# ReelBridge — Technical Design Document

## 0. Relationship to the prior Facebook-only plan

This document generalizes `SAAS_PLAN.md` from one platform to three. Everything under
"carried forward" below is treated as already validated (either by hand against the real
Graph API for CureVera, or as an architectural decision already made) and is **not**
re-litigated here. Everything under "new" comes from research done specifically for this
document (Instagram Graph API content publishing, YouTube Data API v3 upload/scheduling).

**Carried forward, unchanged in substance:**
- TypeScript everywhere; Express API; React + Vite + TanStack Query frontend.
- JWT-in-httpOnly-cookie auth, Postgres-backed refresh tokens.
- Drizzle ORM, Postgres.
- BullMQ + Redis job queue, worker as a separately-deployable, horizontally-scalable service
  from the API — this requirement gets *more* important with three platforms, not less,
  because each platform needs its own queue-level rate limiter (see below).
- S3-compatible object storage via a `StorageAdapter` interface.
- `node-cron`-driven trigger inside the API that only enqueues jobs; all real work and
  retry/backoff logic lives in BullMQ workers.
- Encrypted-at-rest OAuth/page tokens (AES-256-GCM), `assertOwnership` authorization
  boundary pattern for every tenant-scoped route.
- Billing: schema and enforcement call-sites only, no Stripe wiring.
- The validated Facebook 3-phase `/{page_id}/video_reels` upload flow and its confirmed
  constraints (10 min–29 day scheduling window, `/me/accounts` Business Portfolio gap
  requiring manual entry, Meta App Review gating `pages_manage_posts`/`business_management`).

No architecture-style doc was found under `docs/architecture` in this repo at the time of
writing (directory does not exist); the architecture below follows the same style already
established in `SAAS_PLAN.md` (stateless API + separate queue-consuming worker service,
adapter/interface boundaries around anything third-party-shaped), applied across platforms
instead of within one.

## 1. Research findings that shape the architecture

### 1.1 Facebook — scope correction, not new research
Personal-profile publishing has been unavailable via the Graph API since the 2018
`publish_actions` deprecation and remains unavailable in 2026; only Pages (and Groups) are
publishable via API. **ReelBridge drops "personal Facebook accounts" as a target type
entirely** — it was in the original ask but is not implementable against any current Meta
API, App Review or not. This is a hard platform constraint, not a phased rollout decision.

### 1.2 Instagram — new integration, several load-bearing differences from Facebook

- **Auth path chosen**: Instagram content publishing can be reached two ways: (a) "Facebook
  Login for Business," where an IG Business/Creator account is discovered as
  `/{page_id}?fields=instagram_business_account` off an existing Facebook Page connection
  (scopes `instagram_basic`, `instagram_content_publish`, plus the Page scopes ReelBridge
  already needs); or (b) the newer standalone "Instagram API with Instagram Login"
  (`instagram_business_basic`, `instagram_business_content_publish`), which does not require
  a Facebook Page at all. Because ReelBridge already requires a Facebook OAuth flow for Page
  connections, **MVP uses path (a)** — one OAuth flow surfaces both Facebook Pages and any
  linked Instagram Business account, avoiding a second, separate "connect Instagram" login
  for the common case. Path (b) is a plausible future addition for users who want Instagram
  without Facebook, and the data model (see §3) is deliberately platform-connection-shaped so
  adding it later is a new adapter, not a schema change.
- **Container-based publishing, no direct binary upload for video**: publishing is
  `POST /{ig-user-id}/media` (with `media_type=REELS` and a **publicly fetchable
  `video_url`**, not a raw binary body) to create a container, then poll
  `GET /{container-id}?fields=status_code` until `FINISHED`, then
  `POST /{ig-user-id}/media_publish` with the container's `creation_id`. This means, unlike
  Facebook's Page upload (raw binary POST from our server), **Instagram's servers pull the
  video from a URL we hand them** — our S3/R2 storage must produce a short-lived signed URL
  reachable by Meta's fetchers at container-creation time, not assume the bucket is fully
  public.
- **No native scheduled publishing.** This is the single most important Instagram-specific
  finding. Facebook's `/video_reels` endpoint and YouTube's `videos.insert` both accept a
  future publish time and the *platform* holds and executes that future action. Instagram's
  content-publishing API has no equivalent parameter — a container simply **expires 24 hours**
  after creation if not published. There is no way to tell Meta "publish this Reel for me at
  a specific time next week." Practically this means Instagram "scheduling" in ReelBridge is
  **entirely app-managed**: our own worker must wake up at (or very close to) the intended
  publish time and run the full create-container to poll to publish sequence then, not days
  in advance. See §5 (technical risks) for the operational implication.
- **Rate limit**: `100 API-published posts per rolling 24 hours` per IG professional account,
  queryable via `GET /{ig-user-id}/content_publishing_limit`. This is per-account, not
  per-app, so the queue's rate limiter must be keyed per Instagram target, same pattern as
  the per-Facebook-Page limiter in the prior plan.
- **Account requirement**: Business or Creator account only, linked to a Facebook Page;
  personal IG accounts are rejected at connection time (validated via the Page-graph lookup),
  matching the PRD non-goal.

### 1.3 YouTube — new integration

- **Upload mechanism**: resumable upload via `videos.insert` (`uploadType=resumable`),
  chunked, up to 256GB / effectively no documented duration cap for this purpose. OAuth
  scope `https://www.googleapis.com/auth/youtube.upload` is sufficient (narrowest scope that
  covers upload; no need for the broader `youtube` or `youtubepartner` scopes for ReelBridge's
  use case).
- **Native scheduling**: set `status.privacyStatus = "private"` and `status.publishAt` to an
  RFC3339 future timestamp; YouTube itself flips the video to its real target visibility at
  that time. This is native, platform-held scheduling — architecturally the same shape as
  Facebook's `scheduled_publish_time`, unlike Instagram. The upload itself can happen well
  before the scheduled publish time (the file transfer and the "reveal" are decoupled), which
  is the pattern ReelBridge should use: upload as soon as the batch is queued, regardless of
  how far out the scheduled time is, and let YouTube hold the publish moment.
- **Quota — a recently-changed constraint, worth flagging as time-sensitive**: historically
  `videos.insert` cost roughly 1600 units against a shared 10,000-unit/day pool (about 6
  uploads/day on a default, unaudited project) — the reason most competing tools instruct
  users through a YouTube API quota-extension request. Current-generation documentation
  (effective around a Dec 2025 / June 2026 change) shows `videos.insert` moved to its **own
  dedicated bucket, 100 calls/day at 1 unit each**, decoupled from the shared 10,000-unit pool
  used by reads/search. Net effect: default quota now supports roughly 100 uploads/day/project
  rather than roughly 6, a materially easier starting point than the historically-cited
  constraint. **This should be re-verified against Google's live quota dashboard at
  implementation time** before sizing onboarding flows around it, since the source material
  for this number is recent enough that it should be treated as "current as of research
  date," not permanent.
- **Compliance-audit privacy restriction (separate from the quota bucket, and still real)**:
  API projects created after July 28, 2020 upload videos **restricted to `private` visibility
  only** until the project passes a YouTube API Services compliance/audit review. This is
  structurally the same kind of launch-blocking gate as Meta App Review for
  `pages_manage_posts`/`business_management`/`instagram_content_publish` — ReelBridge cannot
  actually publish a public or unlisted YouTube video for arbitrary users until this audit is
  complete, only private ones. Must be planned as an explicit pre-launch milestone (see
  `PROJECT.md`), not discovered late.

## 2. Architecture

Same high-level shape as the prior plan, generalized:

```
                        +---------------+
   React (Vite) SPA --->|  API (Express) |---> Postgres (Drizzle)
                        |  - auth        |---> Redis (BullMQ queues)
                        |  - connections |---> S3/R2 (media)
                        |  - media       |
                        |  - batches     |
                        |  - dashboard   |
                        +-------+-------+
                                | enqueue only
                                v
                        +---------------+
                        |  Worker(s)     |---> Facebook Graph API
                        |  (BullMQ)      |---> Instagram Graph API
                        |  N replicas    |---> YouTube Data API v3
                        +---------------+
```

The key structural addition over the FB-only plan is a **platform adapter layer**: each
platform's publishing quirks (binary-vs-URL upload, native-vs-app-managed scheduling,
container polling, per-platform rate limits, per-platform caption/field shape) are isolated
behind a common interface so the queue processors, dashboard, and data model don't need to
know platform-specific details directly.

```ts
interface PlatformAdapter {
  platform: 'facebook_page' | 'instagram_business' | 'youtube_channel';
  capabilities: {
    nativeScheduling: boolean;       // true: FB, YouTube. false: Instagram
    maxScheduleLeadDays: number | null; // 29 for FB, null/unbounded for YouTube, n/a for IG
    minScheduleLeadMinutes: number | null; // 10 for FB
    uploadMechanism: 'binary' | 'resumable' | 'url-fetch';
    captionShape: 'single-text' | 'title-plus-description'; // FB/IG vs YouTube
  };
  discoverTargets(connectionId): Promise<TargetDescriptor[]>;
  publish(target, mediaAsset, captionPayload, scheduledAt?): Promise<PublishResult>;
  checkStatus(target, platformPostId): Promise<StatusResult>;
  validateMediaConstraints(mediaAsset): ValidationWarning[]; // duration/aspect ratio checks
}
```

This is the concrete mechanism for the "adding a platform later doesn't require a schema
rewrite" requirement: a new platform is a new adapter implementation plus new OAuth routes,
not a change to `post_targets`/`media_assets`/queue processors.

## 3. Data model (Postgres, Drizzle)

Generalizes the prior plan's `fb_pages`/`fb_connections`/`reels` shape into
platform-agnostic tables plus platform-specific metadata columns (`jsonb`), rather than one
table per platform.

```
users                 id, email (unique), password_hash, created_at

platform_connections  id, user_id fk, platform ('facebook' | 'google'),
                      external_account_id, display_name,
                      access_token_ciphertext/iv/tag,
                      refresh_token_ciphertext/iv/tag (nullable; FB long-lived tokens
                      don't rotate the same way Google's refresh tokens do),
                      token_expires_at (nullable), scopes text[], status
                      ('active'|'expired'|'revoked'), created_at, updated_at
                      -- one Facebook connection can yield many facebook_page AND
                      -- instagram_business targets (IG rides on the FB connection);
                      -- one Google connection yields youtube_channel target(s).

publish_targets       id, user_id fk, platform_connection_id fk,
                      platform ('facebook_page'|'instagram_business'|'youtube_channel'),
                      external_id (fb page id / ig business account id / yt channel id),
                      display_name, avatar_url, timezone (nullable, FB pages only),
                      access_token_ciphertext/iv/tag (nullable; Page tokens are
                      per-target, YouTube uses the connection-level refresh token
                      instead, so this is null for youtube_channel rows),
                      token_source ('oauth'|'manual'), metadata jsonb
                      (e.g. IG username, YT default privacy, FB Business-Portfolio flag),
                      is_active, connected_at, last_validated_at
                      -- unique (user_id, platform, external_id)

media_assets          id, user_id fk, original_filename, storage_key, file_size_bytes,
                      duration_seconds, width, height, status
                      ('uploaded'|'validated'|'failed_validation'), uploaded_at
                      -- platform-agnostic; supersedes the prior plan's page-scoped `videos`

post_batches          id, user_id fk, name, created_at, status
                      ('draft'|'scheduling'|'active'|'completed')

post_items            id, batch_id fk, media_asset_id fk, default_caption text,
                      default_title text (nullable, used only for youtube_channel targets),
                      created_at

post_targets          id, post_item_id fk, publish_target_id fk,
                      caption_override text (nullable, falls back to post_items.default_caption),
                      title_override text (nullable, YouTube only),
                      scheduled_at timestamptz (nullable = publish ASAP),
                      status ('pending'|'queued'|'uploading'|'native_scheduled'
                              |'awaiting_app_managed_publish'|'published'|'failed'),
                      platform_post_id, permalink_url, last_error, attempt_count,
                      published_at, created_at, updated_at
                      -- supersedes the prior plan's `reels` table; one row per
                      -- (video, target) pair, which is the actual unit of "fan-out"

schedule_configs      id, publish_target_id fk (unique), daily_slots jsonb,
                      max_schedule_days, min_lead_minutes, cron_expression,
                      next_run_at, is_enabled
                      -- optional recurring/auto-distribute mode, generalized from the
                      -- prior plan's per-page cadence; Phase 2 for non-Facebook targets

schedule_runs         id, publish_target_id fk, triggered_by ('cron'|'manual'),
                      started_at, finished_at, items_considered, items_scheduled,
                      items_leftover, status, error_message

-- billing stubs (schema only, no Stripe wiring yet)
plans                 id, name, price_cents, max_targets, max_posts_per_month, is_default
subscriptions         id, user_id fk (unique), plan_id fk, status,
                      stripe_customer_id (nullable), stripe_subscription_id (nullable),
                      current_period_end (nullable)
```

Notes:
- `assertTargetOwnership(userId, publishTargetId)` is the generalized form of the prior
  plan's `assertPageOwnership` — every route touching a target, media asset, batch, or post
  must go through it.
- `post_targets.status` includes `native_scheduled` (FB/YouTube: we've handed the future
  publish off to the platform and are just polling for confirmation) versus
  `awaiting_app_managed_publish` (Instagram: our own scheduler, not the platform, owns the
  future action) — this distinction is surfaced in the dashboard so users understand
  Instagram's different reliability profile (see §5).

## 4. High-level API surface

```
POST/GET   /api/auth/{signup,login,logout,me}

GET        /api/connections
GET        /api/connections/facebook/start        # covers FB Pages + linked IG discovery
GET        /api/connections/facebook/callback
GET        /api/connections/google/start          # YouTube
GET        /api/connections/google/callback
DELETE     /api/connections/:id

GET        /api/targets                           # unified list, filterable by platform
POST       /api/targets/facebook/manual            # manual page-token fallback, ported as-is
POST       /api/targets/:id/revalidate              # force a token/permission health check
DELETE     /api/targets/:id

POST/GET/DELETE  /api/media[/:id]                   # bulk upload endpoint accepts multiple files

POST       /api/batches
GET        /api/batches/:id
POST       /api/batches/:id/items                   # attach a media asset + default caption
POST       /api/batches/:id/items/:itemId/targets    # assign targets + overrides + schedule
GET        /api/batches/:id/preview                  # dry-run: validates constraints, shows
                                                      # resolved schedule per item, no writes
POST       /api/batches/:id/publish                  # enqueues all resolved post_targets

GET        /api/targets/:id/schedule/config          # Phase-2 recurring/auto-distribute mode
PUT        /api/targets/:id/schedule/config
POST       /api/targets/:id/schedule/trigger

GET        /api/posts                                # filterable: platform, status, target, date
POST       /api/posts/:id/retry

GET        /api/dashboard
GET        /api/targets/:id/dashboard
```

## 5. Key technical risks and open decisions

1. **Instagram has no native scheduling — this is a reliability asymmetry, not just an
   implementation detail.** Once Facebook or YouTube accept a scheduled request, the
   platform itself is responsible for publishing at the right time even if ReelBridge's
   infrastructure is briefly down. Instagram posts scheduled far in the future have no such
   safety net: if the worker fleet is down at the exact intended minute, the post is simply
   late once workers recover, and if a scheduled time is missed by more than the roughly 24h
   container lifetime assumption built into the flow, the create-then-publish sequence must
   be re-run from scratch. Mitigation: a due-job poller with tight polling granularity,
   alerting if an app-managed job is more than N minutes late, and clear UI language framing
   Instagram scheduling as "ReelBridge-managed" rather than "platform-guaranteed."
2. **Meta App Review is a launch gate**, exactly as in the prior plan, now covering
   `pages_manage_posts`, `business_management` (Facebook) and `instagram_content_publish`
   (Instagram) together — until granted, only Facebook accounts added as testers/developers
   on the Meta App can complete OAuth. Manual-entry fallback (already validated for Facebook)
   is the interim path for early trusted users.
3. **YouTube compliance audit is a second, independent launch gate.** Until passed, uploaded
   videos are restricted to `private` regardless of the requested `privacyStatus`, which
   defeats the point of scheduling a public/unlisted post. This must be tracked and resourced
   as its own milestone, not assumed to be covered by "the same review" as Meta's.
4. **YouTube upload quota bucket size is a fast-moving number** (see §1.3) — re-verify at
   implementation time; do not hardcode assumptions about "roughly 6 uploads/day" from older
   material, but also don't assume the more generous current figure is permanent.
5. **Instagram requires a publicly fetchable video URL**, not a binary upload from our
   server. The `StorageAdapter` needs a `getSignedUrl(key, ttl)` capability usable at
   publish-time, and the private-bucket-by-default posture from the prior plan needs this one
   documented exception (time-limited signed URLs, not a public bucket).
6. **Per-platform rate limiting must be per-target, not a single global limiter**, because
   Instagram's 100-posts/24h and YouTube's upload-bucket cap are both per-account/per-project
   constraints distinct from Facebook's Graph API throttling. BullMQ's per-queue limiter
   pattern from the prior plan needs one queue (or one limiter key) per
   `(platform, external_account_or_project)`, not one queue per platform type.
7. **Caption shape differs per platform**: Facebook and Instagram both take a single free-text
   caption; YouTube separates `title` and `description`. The bulk-fan-out UI and the
   `post_items`/`post_targets` schema need to carry both a single default caption and an
   optional title, and adapters must map correctly (e.g. auto-deriving a YouTube title from
   the first line of a caption as a default, user-editable).
8. **Video constraint mismatches across platforms** (aspect ratio, duration limits, codec)
   are not identical between Facebook Reels, Instagram Reels, and YouTube Shorts. MVP does
   pre-publish **validation and warning** (via `validateMediaConstraints` per adapter) but
   does not transform video — a user fanning one clip to all three platforms may need to
   prepare more than one file if a clip fails one platform's constraints, and the UI must
   make that clear per-target rather than silently attempting to publish a non-conforming
   file.
9. **Open decision**: whether IG's Phase-2 direct "Instagram API with Instagram Login" path
   is worth adding before an org/team feature exists, given it targets users without a
   Facebook Page — deferred, not blocking MVP.
10. **Open decision**: how much of the prior plan's continuous CSV-driven "evergreen topup"
    cadence (originally Facebook-only) becomes a first-class Phase 2 feature across all three
    platforms versus staying a manual per-batch flow — MVP ships the per-batch flow; the
    `schedule_configs`/`schedule_runs` tables are present but only exercised for
    Facebook/YouTube targets in Phase 2 given Instagram's app-managed-scheduling risk profile
    argues for tighter, not looser, time windows there.

## 6. Third-party services needed

- Meta Graph API / Facebook Login for Business (Facebook Pages + Instagram Business account
  discovery and publishing) — requires Meta App Review before public onboarding.
- YouTube Data API v3 / Google OAuth 2.0 — requires a YouTube API Services compliance audit
  before public (non-private) video publishing is unrestricted.
- S3-compatible object storage (AWS S3 or Cloudflare R2), with signed-URL generation for the
  Instagram url-fetch requirement.
- Managed Postgres (RDS/Neon/Supabase-class) and managed Redis (Upstash/ElastiCache-class) in
  production; local `docker-compose` (postgres, redis, minio) for dev, same as prior plan.
- Stripe — schema-ready, not integrated in MVP.
- A transactional email provider (e.g. Postmark/Resend-class) for signup verification and
  password reset — not present in the prior plan's scope but required once "any user" signup
  is real rather than a single trusted operator; flagged here as a new, small addition.
