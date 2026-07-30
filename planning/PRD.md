# ReelBridge — Product Requirements Document

## 0. Provenance and research basis

ReelBridge supersedes the Facebook-only plan in `SAAS_PLAN.md` at the repo root. That
document's Facebook Graph API integration (3-phase `/video_reels` upload, the
`scheduled_publish_time` 10-min–29-day window, the `/me/accounts` Business-Portfolio gap,
Meta App Review gating) is treated as validated and is **carried forward, not re-derived**.
The new research for this document focused on the two genuinely new integrations —
Instagram content publishing and YouTube Data API v3 upload/scheduling — plus a couple of
scope corrections that research surfaced and that materially change what "Facebook personal
accounts" and "Instagram" can mean for this product. Sources are cited in `TDD.md`.

## 1. Problem statement

Creators, small businesses, and social-media managers who post short-form video (Reels /
Shorts) to more than one platform currently have to repeat the same manual upload-and-caption
work per platform (Facebook Page, Instagram, YouTube), each with its own dashboard, its own
upload UI, and its own scheduling quirks. Existing all-in-one schedulers (Buffer, Later,
Hootsuite, Metricool, OneUp, Publer) solve this broadly for many platforms but are generalist
tools optimized for single-post composition, not for **bulk** batch upload of a folder of
already-produced short-form videos with per-platform caption variants. ReelBridge is a
focused tool for that specific workflow: upload a batch of videos once, assign them across
one or more connected Facebook Pages / Instagram Business accounts / YouTube channels, tweak
captions per platform where needed, and schedule the whole batch in one pass.

## 2. Target users

- **Primary**: solo creators and small marketing teams who batch-produce short-form video
  (e.g. weekly content batches) and cross-post the same or lightly-adapted clips to Facebook,
  Instagram, and YouTube.
- **Secondary**: agencies managing content for multiple clients' pages/channels (the data
  model must not preclude this later, but multi-tenant **organization/team sharing is not in
  MVP** — see non-goals).
- Out of scope for now: enterprises needing approval workflows, white-label, or SSO.

## 3. Goals

- Let a user connect Facebook Pages, Instagram Business/Creator accounts, and YouTube
  channels to one ReelBridge account.
- Let a user upload a batch of videos in one flow and fan each video out to any combination
  of connected targets, with a shared default caption and per-target overrides.
- Let a user schedule the batch (specific per-item times, or an auto-distributed cadence)
  rather than only publishing immediately.
- Give clear, per-target, per-video status (pending/scheduled/published/failed) with retry.
- Be designed for real multi-tenant scale from day one (job queue, stateless services,
  horizontal worker scaling) — same stance as the prior Facebook-only plan.
- Design the connection/target data model so a fourth platform (TikTok, X, LinkedIn) can be
  added later without a schema rewrite.

## 4. Non-goals (explicit, some corrected by research)

- **Posting to personal Facebook profiles is not a buildable feature at all**, not merely
  deferred. Meta deprecated the `publish_actions` permission for user-timeline publishing in
  2018 (post Cambridge-Analytica) and has not restored it; the Graph API today only allows
  apps to publish to **Pages** (and Groups, which is also not requested here). The original
  ask included "Facebook personal accounts" — research shows this is not possible via any
  Meta API in 2026. ReelBridge supports **Facebook Pages only**, not personal profiles. This
  must be communicated in-product (no "connect your personal profile" option should ever be
  offered) and is called out here so it isn't silently designed around later.
- **Personal (non-Business/Creator) Instagram accounts are unsupported**, for the same
  reason as above: the Instagram Graph content-publishing API requires a Business or Creator
  account linked to a Facebook Page. Users with a personal IG account will be prompted to
  convert it in Instagram's own settings before connecting.
- Video production/editing: no in-app trimming, looping, re-encoding, or aspect-ratio
  conversion. Users upload already-prepared files, same stance as the prior plan. (Per-target
  validation of dimensions/duration against each platform's Reels constraints is in scope, as
  a pre-publish warning — not transformation.)
- No AI caption/hashtag generation in MVP.
- No organization/team seats or role-based sharing in MVP (schema should not block adding
  this later).
- No analytics/insights dashboard beyond basic publish status in MVP.
- No Stripe integration yet — billing schema/enforcement hooks only, exactly as in the prior
  plan.
- The existing CureVera Python/cron pipeline stays exactly as-is and is out of scope
  permanently; it is not a migration source.
- TikTok, X/Twitter, LinkedIn, Pinterest: not in MVP, but the connection/target model is
  designed so adding one is a new adapter + new OAuth route, not a schema rewrite.

## 5. User stories

1. As a new user, I can sign up, log in, and see an empty dashboard prompting me to connect a
   platform.
2. As a user, I can connect a Facebook Page via OAuth, and if the OAuth "list my pages" step
   under-reports (Business Portfolio pages), I can add it manually with a page ID + token and
   guided instructions, exactly as in the prior plan.
3. As a user, connecting Facebook also discovers any Instagram Business account linked to
   that Page, so I don't need a second, separate Instagram login step in the common case.
4. As a user, I can connect a YouTube channel via Google OAuth.
5. As a user, I can upload a batch of video files at once (drag-and-drop, multiple files).
6. As a user, for each video in the batch I can pick which connected targets (any mix of
   Pages/IG accounts/YouTube channels) it should go to, write a default caption, and override
   the caption per target (e.g. different hashtags for Instagram vs. a link-friendly caption
   for Facebook; a title+description split for YouTube, since YouTube captions aren't a
   single free-text field the way FB/IG are).
7. As a user, I can either publish a batch immediately, set an explicit per-item date/time, or
   ask ReelBridge to auto-distribute the batch across a recurring daily cadence (the
   generalized version of the prior plan's slot-generation algorithm).
8. As a user, I can see one unified status view across all platforms for everything I've
   queued, scheduled, published, or failed, and retry a failed item without re-uploading.
9. As a user, if a connected account's token goes bad (revoked, expired, page access lost), I
   see a "reconnect" banner rather than silently-failing scheduled posts.
10. As a user, I'm warned before scheduling if a video doesn't meet a target platform's Reels
    constraints (aspect ratio, duration) rather than discovering the failure after the
    scheduled time passes.

## 6. MVP scope vs. future scope

### MVP

- Auth: email/password signup+login (carried from prior plan: JWT in httpOnly cookie).
- Connections: Facebook Login for Business (Pages + linked IG Business account discovery in
  one flow), manual Facebook Page token fallback, Google OAuth for YouTube.
- Bulk upload of videos into a "batch"; per-video target selection; default + per-target
  caption/title/description override.
- Scheduling: immediate publish, explicit per-item datetime, or auto-distributed daily-slot
  cadence across a batch (generalized slot algorithm).
- Publishing adapters for all three platforms per their real constraints (see TDD): Facebook
  Page Reels (native scheduled publish), YouTube (native `publishAt`), Instagram (app-managed
  scheduling — no native future-publish support exists, see TDD risk section).
- Unified status dashboard, per-item retry, token-health/reconnect banners.
- Billing schema (plans/subscriptions tables, usage-limit check function that always allows
  for now) — no Stripe wiring.
- Multi-tenant isolation (each user owns their own connections/targets/media), no org sharing.

### Future (explicitly deferred, not designed away)

- Organization/team accounts with shared connections and role-based access.
- Stripe billing enforcement.
- TikTok, X/Twitter, LinkedIn adapters.
- AI-assisted caption/hashtag suggestions, and auto aspect-ratio warnings becoming
  auto-transformations (would reintroduce an ffmpeg step deliberately kept out of MVP).
- Post-performance analytics (views, engagement) pulled back from each platform's insights
  APIs.
- Approval workflows (draft → reviewer approve → schedule) for agency use.
- Recurring "evergreen topup" mode fully generalized across all three platforms (MVP supports
  it for the batch/cadence case; the prior plan's continuous CSV-driven perpetual-refill mode
  for a single Facebook Page is a superset behavior that can be revisited post-MVP).

## 7. Success metrics

- Activation: % of signups that connect at least one platform target within 24 hours.
- Core-loop completion: % of users who complete an upload → schedule → published cycle
  within their first session/week.
- Multi-platform adoption: % of active users with 2+ platform types connected (the metric
  that validates the "bridge" premise over a single-platform tool).
- Reliability: % of scheduled items that publish within an acceptable delta of their
  scheduled time, tracked **separately per platform** because Instagram's app-managed
  scheduling has structurally different failure modes than Facebook/YouTube's native
  scheduling (see TDD risks) — this metric should not be blended across platforms or it will
  hide an Instagram-specific reliability problem.
- Failure/retry rate per platform (a proxy for how much of each platform's API quirks are
  correctly handled vs. still causing user-visible failures).
- Time-to-first-published-post from signup.
