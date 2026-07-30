# Facebook Reels Scheduler — SaaS Product

## Context

This started as a personal automation task: loop short videos to 42s and auto-schedule them as Facebook Reels for one page (CureVera), using Python CLI scripts (`fb_reels_uploader/upload_reels.py`, `schedule_reels.py`) plus a weekly cron job to keep topping up Facebook's rolling 28-day scheduling window. That pipeline works and **stays exactly as-is, permanently** — it is not being migrated.

The ask has now grown into a separate, standalone product: a multi-tenant SaaS web app (React + Express + PostgreSQL) that lets *any* user connect their own Facebook Page(s), upload videos + captions, and have reels auto-scheduled on a recurring cadence — productizing the workflow already validated by hand for CureVera. Scope decisions already made with the user:

- **Coverage**: scheduling + dashboard layer only. Video-looping (ffmpeg) stays a separate, out-of-scope step; users upload already-prepared `.mp4` files into the app.
- **Tenancy**: multi-user, multi-page, with real auth. No team/org sharing requested — each user owns their own pages (schema leaves room to add an org layer later without a rewrite).
- **Billing**: design the schema/enforcement points now; do not integrate Stripe yet.
- **Scale**: explicitly designed for real scale (thousands of users/pages) from day one — this rules out the single-process/no-Redis approach that would otherwise be reasonable for a small tool, in favor of a proper job queue and stateless, horizontally-scalable services.
- **CureVera**: stays on its Python + cron pipeline forever; not a data-migration source.

## What must be ported faithfully (not reinvented) from the working scripts

Source of truth: `/home/wajid/Documents/content-creation/cureVera-videos/fb_reels_uploader/{upload_reels.py,schedule_reels.py,config.env,upload_state.json}`.

- **3-phase Graph API upload** against `/{page_id}/video_reels` (`v21.0`): `upload_phase=start` → returns `video_id`+`upload_url` → `POST` raw binary to `upload_url` with `Authorization: OAuth {token}`, `offset`, `file_size` headers → `upload_phase=finish` with `description`, `video_state` (`PUBLISHED`/`DRAFT`/`SCHEDULED`), and `scheduled_publish_time` (unix ts) when scheduling.
- **Empirically confirmed FB constraint**: `scheduled_publish_time` must be 10 min–29 days out; the scripts use a 28-day safety margin.
- **Caption matching**: CSV `title` column matched to video filename stem; duplicate titles resolved by probing `"title"`, `"title 2"`, `"title 3"`… against existing filenames in CSV order. `description` column is the ready-to-post caption as-is (hook + hashtags already inline); `tags` column unused for posting.
- **Slot-generation/cadence algorithm**: pending videos sorted CSV-captioned-first, filename-fallback-last; slots generated forward from `now + 15min` at fixed daily times in a fixed IANA timezone, stopping once a slot would exceed `now + 28 days`; leftovers wait for the next run.
- **Known gotcha, confirmed by hand**: `/me/accounts` can return an *empty* list for pages that live under a Business Portfolio even though `GET /{page_id}?fields=access_token` works directly. Any OAuth "list my pages" flow must have a manual-entry fallback.
- **Known gotcha, confirmed by hand**: `pages_manage_posts` only becomes selectable in Graph API Explorer after the Meta App has a "Use Case" (e.g. "Manage everything on your Page") added in the App Dashboard — it's not available by default.

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript across client/server/shared | Shared Zod schemas for CSV rows, API payloads, and FB response shapes catch mismatches at compile time. |
| Backend | Express (as requested), TS | — |
| Frontend | React + Vite + React Router + TanStack Query | Fast dev loop; TanStack Query for server state (reel status, job progress) instead of hand-rolled fetch/useEffect. |
| Auth | JWT in httpOnly/Secure/SameSite=Lax cookie, `bcrypt` password hashing, Postgres-backed refresh-token table for revocation | Stateless verification, still revocable; no session-store infra needed for auth itself. |
| ORM | **Drizzle ORM** | SQL-shaped query builder suits the timestamp/timezone-heavy scheduling queries; plain-SQL migrations are easy to audit; lighter than Prisma's engine binary. |
| **Job queue** | **BullMQ + Redis**, worker as a **separate deployable service** from the API | Scale requirement rules out a single-process/Postgres-table queue. BullMQ gives per-queue rate limiting (critical for not tripping Facebook's Graph API rate limits across many tenants firing around the same cron tick), retry/backoff, and horizontal worker scaling independent of the API tier. |
| **File storage** | **S3-compatible object storage** (AWS S3 or Cloudflare R2) via a `StorageAdapter` interface, local-disk adapter only for dev | Local disk doesn't work once there's more than one app/worker instance, which the scale requirement implies from day one. |
| Trigger scheduling | `node-cron` inside the API service, only to *enqueue* BullMQ jobs (never does the FB work itself) | Keeps the periodic trigger dumb and fast; all real work — and all retry/backoff/rate-limit logic — lives in BullMQ. |

## Monorepo structure

```
fb-reels-scheduler/
├── docker-compose.yml            # local dev: api, worker, postgres, redis, minio (S3-compatible, dev-only)
├── packages/
│   ├── shared/          # Zod schemas, slot-algorithm constants, shared TS types
│   ├── server/           # Express API — auth, pages, videos, captions, dashboard, OAuth
│   │   └── src/{db,modules,facebook,storage,queues,app.ts,server.ts}
│   ├── worker/            # BullMQ worker process — separate entrypoint, imports @app/shared + a subset of server modules (facebook client, slot algorithm)
│   │   └── src/{processors/{topupSchedule.ts,uploadReel.ts,pollStatus.ts},worker.ts}
│   └── client/            # React app
└── package.json           # workspaces root
```

`server` and `worker` share the Drizzle schema and the Facebook Graph client via `packages/shared` (or a small internal `@app/core` package) so the upload logic is written once, called from both the API (for synchronous "test this token" checks) and the worker (for the actual scheduled uploads).

## Postgres schema (key tables)

```
users            id, email (unique), password_hash, created_at

fb_pages         id, user_id fk, fb_page_id, name, timezone,
                 access_token_ciphertext/iv/tag, token_source ('oauth'|'manual'),
                 token_obtained_at, is_active, created_at
                 -- unique (user_id, fb_page_id)

fb_connections   id, user_id fk, fb_user_id, long_lived_user_token_ciphertext/iv/tag,
                 obtained_at, expires_at

videos           id, page_id fk, original_filename, storage_key, file_size_bytes,
                 status ('pending'|'queued'|'scheduled'|'published'|'failed'), uploaded_at

captions         id, page_id fk, csv_title, description, tags, import_batch_id,
                 matched_video_id fk videos (nullable — re-matched whenever new videos land)

schedule_configs id, page_id fk (unique), daily_slots jsonb, max_schedule_days (default 28),
                 min_lead_minutes (default 15), cron_expression, next_run_at, is_enabled

schedule_runs    id, page_id fk, triggered_by ('cron'|'manual'), started_at, finished_at,
                 videos_considered, videos_scheduled, videos_leftover, status, error_message

reels            id, video_id fk, page_id fk, schedule_run_id fk (nullable), fb_video_id,
                 caption_used, video_state, scheduled_publish_time, status
                 ('pending'|'uploading'|'scheduled'|'published'|'failed'),
                 fb_permalink_url, last_error, attempt_count, created_at, updated_at

-- billing stubs (schema only, no Stripe wiring yet)
plans            id, name, price_cents, max_pages, max_reels_per_month, is_default
subscriptions    id, user_id fk (unique), plan_id fk, status, stripe_customer_id (nullable),
                 stripe_subscription_id (nullable), current_period_end (nullable)
```

Every `fb_pages`-scoped route must go through one `assertPageOwnership(userId, pageId)` helper (join `fb_pages.user_id = req.user.id`) — this is the single most important authorization boundary in a multi-tenant app; do not re-derive it ad hoc per route.

Usage-limit enforcement point: a `checkUsageLimit(userId, action)` function called before video upload / schedule-trigger routes. For now it always allows (reads `plans.max_*` but no plan is enforced); wiring Stripe later means filling in this function's body and the `subscriptions` write path — not restructuring routes.

## Facebook OAuth connect-a-page flow

1. `GET /api/pages/connect/start` → redirect to `https://www.facebook.com/v21.0/dialog/oauth` with `scope=pages_show_list,pages_read_engagement,pages_manage_posts,business_management`, `state` = signed token embedding `userId`+nonce.
2. `GET /api/pages/connect/callback` → verify `state` → exchange `code` for short-lived user token → exchange for long-lived user token (`fb_exchange_token`) → store encrypted in `fb_connections` → `GET /me/accounts` to list pages (**empty/partial result is expected for Business Portfolio pages, not an error** — show "no pages auto-detected, add manually below") → for each returned page, `GET /{page_id}?fields=id,name,access_token` to get the page token, upsert into `fb_pages` (encrypted).
3. **Manual fallback**, always visible: `POST /api/pages/manual { fb_page_id, name, access_token }`, validated server-side with a live `GET /{fb_page_id}?fields=id,name` call before saving. UI includes a collapsible "how to get this token" guide reproducing the Graph API Explorer walkthrough already validated for CureVera (create Use Case → grant scopes → generate token → exchange for long-lived).

**Flagged risk — this is the one that actually matters for a public SaaS**: `pages_manage_posts` and `business_management` are restricted permissions requiring **Meta App Review** for use by accounts that aren't Admins/Developers/Testers on the Meta App. Until the app passes review, only Facebook accounts explicitly added as testers can complete the OAuth flow — i.e., the product cannot onboard arbitrary public users yet. Plan for this explicitly: build the OAuth flow now, but treat "submit for Meta App Review" as a required launch step, not an afterthought, and keep the manual-token-entry fallback as a way for early/trusted users to use the product before review completes.

**Flagged risk**: page tokens obtained this way show `expires_at: 0` ("never expires") but that's contingent on the app staying in good standing — add a lightweight periodic `GET /me?access_token=X` validity check per page (piggybacked on the existing cron tick) that flips `fb_pages.is_active=false` and surfaces a "reconnect" banner on failure, rather than only discovering a dead token when a scheduled post fails.

## Video upload & storage

- `POST /api/pages/:pageId/videos`, multipart, `multer` streaming (not memory-buffered) directly to the S3-compatible bucket via a `StorageAdapter` interface (`save/read/delete`), keyed `{userId}/{pageId}/{videoId}.mp4`.
- Original filename preserved and stored separately from the storage key — the caption-matching algorithm depends on filename stems, so it must never be mangled.
- Enforce `.mp4`-only + max size (e.g. 500MB) via multer limits; no video validation/re-encoding here (that's the separate, out-of-scope looping step).
- Local-disk `StorageAdapter` implementation exists only for running the dev `docker-compose` stack (paired with a MinIO container that speaks the S3 API) — production always targets real S3/R2.

## Scheduler / queue design (BullMQ + Redis)

- **Trigger** (`packages/server`, `node-cron`, ticks every few minutes): queries `schedule_configs WHERE next_run_at <= now() AND is_enabled`, and for each due page enqueues a `topup-schedule` BullMQ job, advancing `next_run_at`. A manual "Run now" button hits the same enqueue path.
- **Worker** (`packages/worker`, separate process/container, horizontally scalable — run N replicas):
  - `topup-schedule` processor: runs the ported slot-generation algorithm for that page (Luxon for DST-safe date math in the page's IANA timezone — a naive JS `Date` would silently break across DST boundaries, unlike Python's `zoneinfo`), writes a `schedule_runs` row, enqueues one `upload-reel` job per video that fits the 28-day window (so each upload is independently retryable, not bundled into one long job).
  - `upload-reel` processor: does the 3-phase FB upload for one video, writes/updates the `reels` row. Queue-level **rate limiter per Facebook App/page** (BullMQ's built-in limiter) to stay under Graph API rate limits even with many tenants scheduling concurrently.
  - `poll-status` processor (new — the CLI never had this): periodically re-checks `GET /{video_id}?fields=status,permalink_url` for reels still `scheduled`, backfills `fb_permalink_url`, flips to `published`.
  - Failures: BullMQ's built-in retry/backoff; on final failure the `reels` row lands in `status='failed'` with `last_error`, visible + retryable from the dashboard (mirrors the CLI's `--retry-failed`).

## Core REST API (representative)

```
POST/GET   /api/auth/{signup,login,logout,me}
GET        /api/pages
GET        /api/pages/connect/start
GET        /api/pages/connect/callback
POST       /api/pages/manual
DELETE     /api/pages/:pageId
POST/GET/DELETE  /api/pages/:pageId/videos[/:videoId]
POST/GET   /api/pages/:pageId/captions[/import]
GET/PUT    /api/pages/:pageId/schedule/config
GET        /api/pages/:pageId/schedule/preview   # dry-run manifest, no writes
POST       /api/pages/:pageId/schedule/trigger
GET        /api/pages/:pageId/reels
POST       /api/pages/:pageId/reels/:reelId/retry
GET        /api/dashboard
GET        /api/pages/:pageId/dashboard
```

## React app (high level)

`Login`/`Signup` → `PagesList` (home, per-page status cards + "Connect a Page") → `ConnectPage` (OAuth button + manual-entry fallback with setup help) → `PageDetail` tabs: `VideoLibrary` (upload dropzone + CSV import with matched/unmatched summary), `ScheduleCalendar` (day-grouped agenda list — a full calendar widget is overkill for 3 slots/day — with editable cadence settings and "Run now"), `ReelsStatus` (filterable table, retry on failed, permalinks on published) → `Settings` (token health/age per page, disconnect).

## Deployment

- **Local dev**: `docker-compose.yml` with `api`, `worker`, `postgres`, `redis`, `minio` (S3-compatible, dev-only) — one command spins up the whole stack.
- **Production**, matching the "real scale" requirement: a managed container platform (Fly.io / Render / Railway / AWS ECS-Fargate — pick one during implementation, architecture doesn't depend on which) running `api` and `worker` as **separately scalable services** (replica count independent per service), managed Postgres (RDS/Neon/Supabase), managed Redis (Upstash/ElastiCache), and real S3/R2 for storage. Plain `docker-compose` alone does not provide multi-host horizontal scaling — it's the local/dev artifact, not the production topology.
- Migrations run as a self-migrating step (`drizzle-kit migrate`) on `api` container start.
- Secrets: `ENCRYPTION_KEY` (AES-256-GCM for stored tokens), `FB_APP_SECRET`, `JWT_SECRET` all distinct, all from env/secrets manager, never logged.

## Verification plan

1. **Unit tests** (Vitest): slot-generation algorithm (duplicate-title matching, leftover-count math, DST-boundary date in a real US timezone), CSV caption-matching fixtures, token encrypt/decrypt round-trip.
2. **Integration tests** against a test Postgres+Redis: signup → connect page (manual entry, mocked FB validation) → upload video → import CSV → trigger schedule → assert `reels` rows with correct `scheduled_publish_time`.
3. **Real Graph API verification**, reusing the exact manual pattern already validated for CureVera: after scheduling a real reel on a disposable test Page, `curl "https://graph.facebook.com/v21.0/{video_id}?fields=status,permalink_url,description&access_token=..."` and confirm `publish_status == "scheduled"`, caption matches, and `scheduled_publish_time` matches what's stored (catches timezone-conversion bugs before they cause silently-wrong post times).
4. **Business Portfolio fallback test**: connect a page that lives under a Business Portfolio, confirm `/me/accounts` under-reports it and that manual entry still works.
5. **Queue durability test**: kill the `worker` container mid-job, restart it, confirm BullMQ redelivers/retries rather than losing the job — this is the concrete proof that "always-on scheduler" no longer depends on any one machine being up, unlike the current cron-on-laptop setup.
6. **Multi-tenant isolation test**: two users, each with a page, confirm neither can see/act on the other's pages/videos/reels via the API (not just the UI).

### Critical files to build against

- `fb_reels_uploader/upload_reels.py` → port into `packages/worker/src/facebook/graphClient.ts` (or a shared package both `server` and `worker` import).
- `fb_reels_uploader/schedule_reels.py` → port into `packages/worker/src/processors/topupSchedule.ts` (slot algorithm) and `packages/server/src/modules/captions/import.ts` (CSV matching).
- `fb_reels_uploader/upload_state.json` shape → models the `reels`/`schedule_runs` tables.
